/**
 * Minimal SIP message parser and generator.
 * Handles the subset of SIP needed for Voice Connector integration:
 * INVITE, ACK, BYE, and their responses.
 */

export interface SipMessage {
  // Request fields (only for requests)
  method?: string;
  requestUri?: string;
  // Response fields (only for responses)
  statusCode?: number;
  reasonPhrase?: string;
  // Common - single-value headers (lowercase key)
  headers: Record<string, string>;
  // Raw header lines preserved in order (for Via, Record-Route, etc.)
  rawHeaders: string[];
  body: string;
}

export function parseSipMessage(raw: string): SipMessage {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headerSection = headerEnd >= 0 ? raw.substring(0, headerEnd) : raw;
  const body = headerEnd >= 0 ? raw.substring(headerEnd + 4) : '';

  const lines = headerSection.split('\r\n');
  const firstLine = lines[0];

  let method: string | undefined;
  let requestUri: string | undefined;
  let statusCode: number | undefined;
  let reasonPhrase: string | undefined;

  // Determine if request or response
  if (firstLine.startsWith('SIP/')) {
    // Response: SIP/2.0 200 OK
    const parts = firstLine.split(' ');
    statusCode = parseInt(parts[1], 10);
    reasonPhrase = parts.slice(2).join(' ');
  } else {
    // Request: INVITE sip:... SIP/2.0
    const parts = firstLine.split(' ');
    method = parts[0];
    requestUri = parts[1];
  }

  // Parse headers (handle multi-line headers with leading whitespace)
  const headers: Record<string, string> = {};
  const rawHeaders: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(' ') || line.startsWith('\t')) {
      // Continuation of previous header
      if (rawHeaders.length > 0) {
        rawHeaders[rawHeaders.length - 1] += ' ' + line.trim();
      }
      const lastKey = Object.keys(headers).pop();
      if (lastKey) headers[lastKey] += ' ' + line.trim();
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.substring(0, colonIdx).trim();
    const value = line.substring(colonIdx + 1).trim();
    // Preserve raw header line (keeps original casing and order)
    rawHeaders.push(line);
    // Store with lowercase key for easy lookup (last value wins for single-value headers)
    headers[key.toLowerCase()] = value;
  }

  return { method, requestUri, statusCode, reasonPhrase, headers, rawHeaders, body };
}

/**
 * Extract phone number from SIP From/To header value.
 * Examples:
 *   <sip:+14155551234@host> -> +14155551234
 *   "Display" <sip:+14155551234@host>;tag=xyz -> +14155551234
 *   sip:+14155551234@host -> +14155551234
 */
export function extractPhoneFromHeader(headerValue: string): string {
  // Try to extract from <sip:...@...>
  const sipMatch = headerValue.match(/sip:([^@>]+)@/);
  if (sipMatch) return sipMatch[1];
  // Try to extract from <tel:...>
  const telMatch = headerValue.match(/tel:([^>]+)/);
  if (telMatch) return telMatch[1];
  return '';
}

/**
 * Extract tag parameter from From/To header.
 */
export function extractTag(headerValue: string): string {
  const match = headerValue.match(/;tag=([^\s;>]+)/);
  return match ? match[1] : '';
}

/**
 * Generate a SIP response message.
 * Use rawHeaderLines for headers that must preserve order/multiplicity (Via, Record-Route).
 * Use headers for single-value headers.
 */
export function buildSipResponse(opts: {
  statusCode: number;
  reasonPhrase: string;
  rawHeaderLines?: string[];
  headers?: Record<string, string>;
  body?: string;
}): string {
  const { statusCode, reasonPhrase, rawHeaderLines, headers, body } = opts;
  let msg = `SIP/2.0 ${statusCode} ${reasonPhrase}\r\n`;

  // Write raw header lines first (preserves Via, Record-Route order)
  if (rawHeaderLines) {
    for (const line of rawHeaderLines) {
      msg += `${line}\r\n`;
    }
  }

  // Write additional single-value headers
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      msg += `${key}: ${value}\r\n`;
    }
  }

  const bodyStr = body || '';
  msg += `Content-Length: ${Buffer.byteLength(bodyStr)}\r\n`;
  msg += `\r\n`;
  msg += bodyStr;

  return msg;
}

/**
 * Generate a SIP request message (BYE, ACK, INVITE).
 */
export function buildSipRequest(opts: {
  method: string;
  requestUri: string;
  headers: Record<string, string>;
  body?: string;
}): string {
  const { method, requestUri, headers, body } = opts;
  let msg = `${method} ${requestUri} SIP/2.0\r\n`;

  for (const [key, value] of Object.entries(headers)) {
    msg += `${key}: ${value}\r\n`;
  }

  const bodyStr = body || '';
  msg += `Content-Length: ${Buffer.byteLength(bodyStr)}\r\n`;
  msg += `\r\n`;
  msg += bodyStr;

  return msg;
}

/**
 * Generate a random SIP tag.
 */
export function generateTag(): string {
  return Math.random().toString(36).substring(2, 14);
}

/**
 * Generate a random SIP branch (must start with z9hG4bK per RFC 3261).
 */
export function generateBranch(): string {
  return 'z9hG4bK' + Math.random().toString(36).substring(2, 14);
}
