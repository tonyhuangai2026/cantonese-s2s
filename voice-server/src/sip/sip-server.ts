/**
 * Minimal SIP User Agent Server for Amazon Chime SDK Voice Connector.
 *
 * Handles incoming SIP INVITE → 200 OK → ACK → RTP session → BYE.
 * No SIP REGISTER needed (Voice Connector uses direct routing via Origination).
 */

import * as dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import {
  parseSipMessage,
  buildSipResponse,
  buildSipRequest,
  extractPhoneFromHeader,
  extractTag,
  generateTag,
  generateBranch,
  type SipMessage,
} from './sip-parser';
import { parseSdp, buildSdpAnswer, type SdpMediaInfo } from './sdp-parser';
import { RtpSession } from './rtp-session';
import { PortPool } from './port-pool';

export interface IncomingCallInfo {
  /** Unique call identifier (SIP Call-ID) */
  callId: string;
  /** Caller phone number (E.164) */
  callerPhone: string;
  /** Called phone number (E.164) */
  calleePhone: string;
  /** RTP session for bidirectional audio */
  rtpSession: RtpSession;
  /** Remote SDP media info */
  remoteSdp: SdpMediaInfo;
}

interface SipDialog {
  callId: string;
  fromHeader: string;
  toHeader: string;
  localTag: string;
  remoteTag: string;
  remoteAddress: string;
  remotePort: number;
  viaHeader: string;
  cseq: number;
  rtpSession: RtpSession;
  rtpPort: number;
}

export type IncomingCallCallback = (call: IncomingCallInfo) => void;
export type CallEndedCallback = (callId: string, reason: string) => void;

export class SipServer extends EventEmitter {
  private socket: dgram.Socket | null = null;
  private publicIp: string;
  private sipPort: number;
  private portPool: PortPool;
  private dialogs: Map<string, SipDialog> = new Map();

  private onIncomingCallCb: IncomingCallCallback | null = null;
  private onCallEndedCb: CallEndedCallback | null = null;

  constructor(opts: {
    publicIp: string;
    sipPort?: number;
    rtpPortBase: number;
    rtpPortCount: number;
  }) {
    super();
    this.publicIp = opts.publicIp;
    this.sipPort = opts.sipPort || 5060;
    this.portPool = new PortPool(opts.rtpPortBase, opts.rtpPortCount);
  }

  /**
   * Start listening for SIP messages on UDP port.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error(`[SIP] Socket error:`, err);
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        const raw = msg.toString('utf-8');
        this.handleMessage(raw, rinfo.address, rinfo.port);
      });

      this.socket.bind(this.sipPort, () => {
        console.log(`[SIP] Listening on UDP port ${this.sipPort}`);
        resolve();
      });
    });
  }

  /**
   * Stop the SIP server and all active sessions.
   */
  stop(): void {
    for (const [callId, dialog] of this.dialogs) {
      dialog.rtpSession.stop();
      this.portPool.release(dialog.rtpPort);
    }
    this.dialogs.clear();
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }
    console.log('[SIP] Server stopped');
  }

  /**
   * Register callback for incoming calls.
   */
  onIncomingCall(cb: IncomingCallCallback): void {
    this.onIncomingCallCb = cb;
  }

  /**
   * Register callback for when calls end (remote BYE).
   */
  onCallEnded(cb: CallEndedCallback): void {
    this.onCallEndedCb = cb;
  }

  /**
   * End a call by sending SIP BYE.
   */
  endCall(callId: string): void {
    const dialog = this.dialogs.get(callId);
    if (!dialog) {
      console.warn(`[SIP] No dialog found for callId ${callId}`);
      return;
    }

    dialog.cseq++;
    const byeMsg = buildSipRequest({
      method: 'BYE',
      requestUri: `sip:${dialog.remoteAddress}:${dialog.remotePort}`,
      headers: {
        'Via': `SIP/2.0/UDP ${this.publicIp}:${this.sipPort};branch=${generateBranch()}`,
        'From': dialog.toHeader, // We are the To party (UAS), so From in BYE is our header
        'To': dialog.fromHeader,
        'Call-ID': dialog.callId,
        'CSeq': `${dialog.cseq} BYE`,
        'Max-Forwards': '70',
      },
    });

    this.sendSip(byeMsg, dialog.remoteAddress, dialog.remotePort);
    this.cleanupDialog(callId);
    console.log(`[SIP] Sent BYE for call ${callId}`);
  }

  /**
   * Get active call count.
   */
  get activeCallCount(): number {
    return this.dialogs.size;
  }

  // --- Internal handlers ---

  private handleMessage(raw: string, fromIp: string, fromPort: number): void {
    const msg = parseSipMessage(raw);

    if (msg.method) {
      // It's a request
      switch (msg.method) {
        case 'INVITE':
          this.handleInvite(msg, fromIp, fromPort);
          break;
        case 'ACK':
          this.handleAck(msg);
          break;
        case 'BYE':
          this.handleBye(msg, fromIp, fromPort);
          break;
        case 'OPTIONS':
          this.handleOptions(msg, fromIp, fromPort);
          break;
        case 'CANCEL':
          this.handleCancel(msg, fromIp, fromPort);
          break;
        default:
          console.log(`[SIP] Ignoring ${msg.method} from ${fromIp}:${fromPort}`);
      }
    } else if (msg.statusCode) {
      // It's a response (to our BYE, etc.)
      console.log(`[SIP] Received ${msg.statusCode} ${msg.reasonPhrase} from ${fromIp}:${fromPort}`);
    }
  }

  private async handleInvite(msg: SipMessage, fromIp: string, fromPort: number): Promise<void> {
    const callId = msg.headers['call-id'] || '';
    const fromHeader = msg.headers['from'] || '';
    const toHeader = msg.headers['to'] || '';
    const viaHeader = msg.headers['via'] || '';
    const cseqHeader = msg.headers['cseq'] || '';

    console.log(`[SIP] Received INVITE, Call-ID: ${callId}, From: ${fromHeader}, UDP source: ${fromIp}:${fromPort}`);
    console.log(`[SIP] Via headers: ${msg.rawHeaders.filter(h => h.toLowerCase().startsWith('via:')).join(' | ')}`);

    // Check if this is a re-INVITE (existing dialog)
    if (this.dialogs.has(callId)) {
      console.log(`[SIP] Re-INVITE for existing call ${callId}, sending 200 OK`);
      // For re-INVITE, respond with current SDP
      const dialog = this.dialogs.get(callId)!;
      const sdpAnswer = buildSdpAnswer({
        localIp: this.publicIp,
        localPort: dialog.rtpSession.getLocalPort(),
      });
      this.send200Ok(msg, fromIp, fromPort, sdpAnswer, dialog.localTag);
      return;
    }

    // Allocate RTP port
    const rtpPort = this.portPool.allocate();
    if (rtpPort === undefined) {
      console.error('[SIP] No RTP ports available, rejecting call');
      this.sendResponse(msg, 503, 'Service Unavailable', fromIp, fromPort);
      return;
    }

    // Parse remote SDP
    const remoteSdp = parseSdp(msg.body);
    if (!remoteSdp.remoteIp || !remoteSdp.remotePort) {
      console.error('[SIP] Invalid SDP in INVITE');
      this.portPool.release(rtpPort);
      this.sendResponse(msg, 400, 'Bad Request', fromIp, fromPort);
      return;
    }

    // Send 100 Trying
    this.sendResponse(msg, 100, 'Trying', fromIp, fromPort);

    // Create RTP session
    const rtpSession = new RtpSession(rtpPort);
    try {
      await rtpSession.start();
    } catch (err) {
      console.error('[SIP] Failed to start RTP session:', err);
      this.portPool.release(rtpPort);
      this.sendResponse(msg, 500, 'Internal Server Error', fromIp, fromPort);
      return;
    }

    rtpSession.setRemote(remoteSdp.remoteIp, remoteSdp.remotePort);

    // Generate our tag for the To header
    const localTag = generateTag();

    // Build SDP answer
    const sdpAnswer = buildSdpAnswer({
      localIp: this.publicIp,
      localPort: rtpPort,
    });

    // Send 200 OK with SDP
    this.send200Ok(msg, fromIp, fromPort, sdpAnswer, localTag);

    // Store dialog
    const dialog: SipDialog = {
      callId,
      fromHeader,
      toHeader: toHeader.includes(';tag=') ? toHeader : `${toHeader};tag=${localTag}`,
      localTag,
      remoteTag: extractTag(fromHeader),
      remoteAddress: fromIp,
      remotePort: fromPort,
      viaHeader,
      cseq: parseInt(cseqHeader.split(' ')[0]) || 1,
      rtpSession,
      rtpPort,
    };
    this.dialogs.set(callId, dialog);

    // Extract phone numbers
    const callerPhone = extractPhoneFromHeader(fromHeader);
    const calleePhone = extractPhoneFromHeader(toHeader);

    console.log(`[SIP] Call established: ${callId}, caller: ${callerPhone}, callee: ${calleePhone}, RTP port: ${rtpPort}`);

    // Notify application
    if (this.onIncomingCallCb) {
      this.onIncomingCallCb({
        callId,
        callerPhone,
        calleePhone,
        rtpSession,
        remoteSdp,
      });
    }
  }

  private handleAck(msg: SipMessage): void {
    const callId = msg.headers['call-id'] || '';
    console.log(`[SIP] Received ACK for call ${callId}`);
    // ACK completes the 3-way handshake, RTP should already be flowing
  }

  private handleBye(msg: SipMessage, fromIp: string, fromPort: number): void {
    const callId = msg.headers['call-id'] || '';
    console.log(`[SIP] Received BYE for call ${callId}`);

    // Send 200 OK for BYE
    this.sendResponse(msg, 200, 'OK', fromIp, fromPort);

    // Cleanup
    this.cleanupDialog(callId);

    // Notify application
    if (this.onCallEndedCb) {
      this.onCallEndedCb(callId, 'remote_hangup');
    }
  }

  private handleOptions(msg: SipMessage, fromIp: string, fromPort: number): void {
    // Voice Connector may send OPTIONS as health check
    this.sendResponse(msg, 200, 'OK', fromIp, fromPort);
  }

  private handleCancel(msg: SipMessage, fromIp: string, fromPort: number): void {
    const callId = msg.headers['call-id'] || '';
    console.log(`[SIP] Received CANCEL for call ${callId}`);

    // Send 200 OK for CANCEL
    this.sendResponse(msg, 200, 'OK', fromIp, fromPort);

    // Send 487 Request Terminated for the original INVITE
    this.sendResponse(msg, 487, 'Request Terminated', fromIp, fromPort);

    this.cleanupDialog(callId);
    if (this.onCallEndedCb) {
      this.onCallEndedCb(callId, 'cancelled');
    }
  }

  /**
   * Extract Via and Record-Route headers from the raw INVITE headers
   * to echo them correctly in responses (preserves order and multiplicity).
   */
  private getEchoHeaders(msg: SipMessage): string[] {
    const lines: string[] = [];
    for (const line of msg.rawHeaders) {
      const lowerLine = line.toLowerCase();
      if (lowerLine.startsWith('via:') || lowerLine.startsWith('v:') ||
          lowerLine.startsWith('record-route:')) {
        lines.push(line);
      }
    }
    return lines;
  }

  private send200Ok(msg: SipMessage, toIp: string, toPort: number, sdpBody: string, localTag: string): void {
    const toHeader = msg.headers['to'] || '';
    const toWithTag = toHeader.includes(';tag=') ? toHeader : `${toHeader};tag=${localTag}`;

    const response = buildSipResponse({
      statusCode: 200,
      reasonPhrase: 'OK',
      rawHeaderLines: this.getEchoHeaders(msg),
      headers: {
        'From': msg.headers['from'] || '',
        'To': toWithTag,
        'Call-ID': msg.headers['call-id'] || '',
        'CSeq': msg.headers['cseq'] || '',
        'Contact': `<sip:${this.publicIp}:${this.sipPort}>`,
        'Content-Type': 'application/sdp',
        'Allow': 'INVITE, ACK, BYE, CANCEL, OPTIONS',
        'User-Agent': 'voice-agent-platform/1.0',
      },
      body: sdpBody,
    });

    this.sendSip(response, toIp, toPort);
  }

  private sendResponse(msg: SipMessage, statusCode: number, reasonPhrase: string, toIp: string, toPort: number): void {
    const response = buildSipResponse({
      statusCode,
      reasonPhrase,
      rawHeaderLines: this.getEchoHeaders(msg),
      headers: {
        'From': msg.headers['from'] || '',
        'To': msg.headers['to'] || '',
        'Call-ID': msg.headers['call-id'] || '',
        'CSeq': msg.headers['cseq'] || '',
        'User-Agent': 'voice-agent-platform/1.0',
      },
    });

    this.sendSip(response, toIp, toPort);
  }

  private sendSip(message: string, ip: string, port: number): void {
    if (!this.socket) return;
    // Log outbound SIP message (first 3 lines for debugging)
    const preview = message.split('\r\n').slice(0, 5).join(' | ');
    console.log(`[SIP] >>> Sending to ${ip}:${port}: ${preview}`);
    const buf = Buffer.from(message, 'utf-8');
    this.socket.send(buf, port, ip, (err) => {
      if (err) console.error(`[SIP] Send error to ${ip}:${port}:`, err.message);
    });
  }

  private cleanupDialog(callId: string): void {
    const dialog = this.dialogs.get(callId);
    if (dialog) {
      dialog.rtpSession.stop();
      this.portPool.release(dialog.rtpPort);
      this.dialogs.delete(callId);
      console.log(`[SIP] Dialog cleaned up: ${callId}`);
    }
  }
}
