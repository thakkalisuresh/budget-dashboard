/**
 * Shared helpers for WhatsApp webhook functions.
 * Files starting with "_" are NOT deployed as functions by Netlify.
 */
import crypto from 'node:crypto';

export const ALLOWED_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
]);

const MAGIC_BYTES = {
  'image/jpeg': [0xFF, 0xD8, 0xFF],
  'image/png':  [0x89, 0x50, 0x4E, 0x47],
  'image/webp': null,
  'application/pdf': [0x25, 0x50, 0x44, 0x46],
};

export function validateMagicBytes(buffer, declaredType) {
  const bytes = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer || buffer);
  if (bytes.length < 12) return false;
  if (declaredType === 'image/webp') {
    return bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
           bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  const expected = MAGIC_BYTES[declaredType];
  if (!expected) return false;
  return expected.every((b, i) => bytes[i] === b);
}

export function validateTwilioSignature(url, params, signature, authToken) {
  if (!authToken || !signature) return false;
  const sortedKeys = Object.keys(params).sort();
  const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
  const expected = crypto.createHmac('sha1', authToken).update(data).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

export function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function twilioResponse(message) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(twiml, { status: 200, headers: { 'Content-Type': 'text/xml' } });
}

export function emptyTwiml() {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200, headers: { 'Content-Type': 'text/xml' },
  });
}

export function isAllowedPhone(phone, allowedList) {
  if (!allowedList || allowedList.length === 0) return true;
  return allowedList.includes(phone);
}
