/**
 * Minimal SDP parser and generator for RTP media negotiation.
 * Handles the subset needed for PCMU (G.711 u-law) audio sessions.
 */

export interface SdpMediaInfo {
  /** Remote RTP IP address from c= line */
  remoteIp: string;
  /** Remote RTP port from m= line */
  remotePort: number;
  /** Supported payload types (we only care about 0 = PCMU) */
  payloadTypes: number[];
}

/**
 * Parse SDP body to extract remote media endpoint information.
 */
export function parseSdp(sdp: string): SdpMediaInfo {
  let remoteIp = '';
  let remotePort = 0;
  let payloadTypes: number[] = [];

  // Track connection address at session and media level
  let sessionIp = '';
  let mediaIp = '';
  let inMediaSection = false;

  const lines = sdp.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('c=IN IP4 ')) {
      const ip = line.substring('c=IN IP4 '.length).trim().split('/')[0];
      if (inMediaSection) {
        mediaIp = ip;
      } else {
        sessionIp = ip;
      }
    } else if (line.startsWith('c=IN IP6 ')) {
      const ip = line.substring('c=IN IP6 '.length).trim().split('/')[0];
      if (inMediaSection) {
        mediaIp = ip;
      } else {
        sessionIp = ip;
      }
    } else if (line.startsWith('m=audio ')) {
      inMediaSection = true;
      // m=audio <port> RTP/AVP <payload-types...>
      const parts = line.split(/\s+/);
      remotePort = parseInt(parts[1], 10);
      payloadTypes = parts.slice(3).map(Number).filter(n => !isNaN(n));
    } else if (line.startsWith('m=') && !line.startsWith('m=audio')) {
      // Other media section, stop parsing audio
      if (inMediaSection) break;
    }
  }

  remoteIp = mediaIp || sessionIp;

  return { remoteIp, remotePort, payloadTypes };
}

/**
 * Generate an SDP answer for our RTP endpoint.
 * Offers PCMU (payload type 0) at 8000 Hz.
 */
export function buildSdpAnswer(opts: {
  localIp: string;
  localPort: number;
  sessionId?: string;
}): string {
  const { localIp, localPort } = opts;
  const sessionId = opts.sessionId || String(Math.floor(Math.random() * 1e9));

  return [
    'v=0',
    `o=- ${sessionId} ${sessionId} IN IP4 ${localIp}`,
    's=voice-agent',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${localPort} RTP/AVP 0`,
    'a=rtpmap:0 PCMU/8000',
    'a=ptime:20',
    'a=sendrecv',
    '',
  ].join('\r\n');
}
