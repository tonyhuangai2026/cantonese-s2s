/**
 * RTP session for bidirectional audio streaming.
 * Handles RTP packet construction/parsing and mulaw<->PCM conversion.
 *
 * Audio format: PCMU (G.711 u-law), 8000 Hz, mono
 * RTP packetization: 20ms frames = 160 samples per packet
 */

import * as dgram from 'node:dgram';
import { mulaw } from 'alawmulaw';

const RTP_HEADER_SIZE = 12;
const SAMPLES_PER_PACKET = 160; // 20ms at 8000Hz
const PACKET_INTERVAL_MS = 20;
const MULAW_SILENCE = 0xFF; // Silence byte in mulaw encoding

export type AudioCallback = (pcmBuffer: Buffer) => void;

export class RtpSession {
  private socket: dgram.Socket | null = null;
  private remoteIp: string = '';
  private remotePort: number = 0;
  private localPort: number;

  // RTP header state
  private sequenceNumber: number = 0;
  private timestamp: number = 0;
  private ssrc: number;

  // Outbound audio queue
  private outboundQueue: Buffer[] = [];
  private sendTimer: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;

  private onAudioCb: AudioCallback | null = null;

  constructor(localPort: number) {
    this.localPort = localPort;
    this.ssrc = Math.floor(Math.random() * 0xFFFFFFFF);
    this.sequenceNumber = Math.floor(Math.random() * 0xFFFF);
    this.timestamp = Math.floor(Math.random() * 0xFFFFFFFF);
  }

  /**
   * Start listening for RTP packets on the assigned port.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');

      this.socket.on('error', (err) => {
        console.error(`[RTP] Socket error on port ${this.localPort}:`, err);
        reject(err);
      });

      this.socket.on('message', (msg, rinfo) => {
        this.handleIncomingPacket(msg);
      });

      this.socket.bind(this.localPort, () => {
        console.log(`[RTP] Listening on UDP port ${this.localPort}`);
        this.running = true;
        this.startSendLoop();
        resolve();
      });
    });
  }

  /**
   * Stop the RTP session and release resources.
   */
  stop(): void {
    this.running = false;
    if (this.sendTimer) {
      clearInterval(this.sendTimer);
      this.sendTimer = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (_) {}
      this.socket = null;
    }
    this.outboundQueue = [];
    console.log(`[RTP] Session stopped on port ${this.localPort}`);
  }

  /**
   * Set the remote RTP endpoint (from SDP).
   */
  setRemote(ip: string, port: number): void {
    this.remoteIp = ip;
    this.remotePort = port;
    console.log(`[RTP] Remote endpoint set to ${ip}:${port}`);
  }

  /**
   * Register callback for received audio (decoded to 16-bit PCM).
   */
  onAudioReceived(cb: AudioCallback): void {
    this.onAudioCb = cb;
  }

  /**
   * Queue PCM audio for sending to the remote endpoint.
   * PCM format: 16-bit signed LE, 8000 Hz, mono.
   */
  sendAudio(pcmBuffer: Buffer): void {
    if (!this.running) return;
    this.outboundQueue.push(pcmBuffer);
  }

  /**
   * Clear outbound audio queue (used when Nova Sonic interrupts/barge-in).
   */
  clearQueue(): void {
    this.outboundQueue = [];
  }

  getLocalPort(): number {
    return this.localPort;
  }

  // --- Internal ---

  /**
   * Parse incoming RTP packet: strip header, decode mulaw to PCM.
   */
  private handleIncomingPacket(packet: Buffer): void {
    if (packet.length < RTP_HEADER_SIZE) return;

    // Extract mulaw payload (skip 12-byte header + any CSRC/extension)
    const cc = packet[0] & 0x0F; // CSRC count
    const hasExtension = (packet[0] & 0x10) !== 0;
    let offset = RTP_HEADER_SIZE + cc * 4;

    if (hasExtension && packet.length > offset + 4) {
      const extLength = packet.readUInt16BE(offset + 2);
      offset += 4 + extLength * 4;
    }

    if (offset >= packet.length) return;

    const mulawPayload = packet.subarray(offset);

    // Decode mulaw to 16-bit PCM
    const pcmSamples = mulaw.decode(mulawPayload);
    const pcmBuffer = Buffer.from(pcmSamples.buffer, pcmSamples.byteOffset, pcmSamples.byteLength);

    if (this.onAudioCb) {
      this.onAudioCb(pcmBuffer);
    }
  }

  /**
   * Send loop: every 20ms, send one RTP packet to the remote endpoint.
   * If no audio is queued, send silence to keep the RTP stream alive.
   */
  private startSendLoop(): void {
    this.sendTimer = setInterval(() => {
      if (!this.running || !this.socket || !this.remoteIp || !this.remotePort) return;

      let mulawPayload: Buffer;

      if (this.outboundQueue.length > 0) {
        // Consume queued PCM, encode to mulaw
        const pcm = this.drainQueue(SAMPLES_PER_PACKET * 2); // 2 bytes per 16-bit sample
        const pcmSamples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
        const encoded = mulaw.encode(pcmSamples);
        mulawPayload = Buffer.from(encoded);
      } else {
        // Send silence
        mulawPayload = Buffer.alloc(SAMPLES_PER_PACKET, MULAW_SILENCE);
      }

      const rtpPacket = this.buildRtpPacket(mulawPayload);
      this.socket.send(rtpPacket, this.remotePort, this.remoteIp, (err) => {
        if (err) console.error('[RTP] Send error:', err.message);
      });

      this.sequenceNumber = (this.sequenceNumber + 1) & 0xFFFF;
      this.timestamp = (this.timestamp + SAMPLES_PER_PACKET) >>> 0;
    }, PACKET_INTERVAL_MS);
  }

  /**
   * Drain up to `bytes` from the outbound queue into a single buffer.
   */
  private drainQueue(bytes: number): Buffer {
    const chunks: Buffer[] = [];
    let remaining = bytes;

    while (remaining > 0 && this.outboundQueue.length > 0) {
      const chunk = this.outboundQueue[0];
      if (chunk.length <= remaining) {
        chunks.push(this.outboundQueue.shift()!);
        remaining -= chunk.length;
      } else {
        // Split chunk
        chunks.push(chunk.subarray(0, remaining));
        this.outboundQueue[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }

    const result = Buffer.concat(chunks);
    // Pad with silence if not enough data
    if (result.length < bytes) {
      const padded = Buffer.alloc(bytes);
      result.copy(padded);
      return padded;
    }
    return result;
  }

  /**
   * Build an RTP packet with the given payload.
   * Header: V=2, P=0, X=0, CC=0, M=0, PT=0 (PCMU)
   */
  private buildRtpPacket(payload: Buffer): Buffer {
    const header = Buffer.alloc(RTP_HEADER_SIZE);

    // Byte 0: V=2, P=0, X=0, CC=0 => 0x80
    header[0] = 0x80;
    // Byte 1: M=0, PT=0 (PCMU)
    header[1] = 0x00;
    // Bytes 2-3: Sequence number
    header.writeUInt16BE(this.sequenceNumber, 2);
    // Bytes 4-7: Timestamp
    header.writeUInt32BE(this.timestamp, 4);
    // Bytes 8-11: SSRC
    header.writeUInt32BE(this.ssrc, 8);

    return Buffer.concat([header, payload]);
  }
}
