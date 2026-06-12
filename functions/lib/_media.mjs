/**
 * Media validation helpers (image/PDF magic-byte checks).
 * Extracted verbatim from netlify/functions/_whatsapp.mjs — the WhatsApp/Twilio
 * transport code is out of scope, but these two utilities are shared by the
 * Telegram media path, so they live here free of Twilio dependencies.
 */

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
