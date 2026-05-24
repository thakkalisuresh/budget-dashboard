import { describe, it, expect } from 'vitest';
import {
  validateMagicBytes,
  validateTwilioSignature,
  escapeXml,
  isAllowedPhone,
  ALLOWED_MEDIA_TYPES,
} from '../../netlify/functions/_whatsapp.mjs';

describe('validateTwilioSignature', () => {
  const AUTH_TOKEN = 'test_auth_token_12345';
  const URL = 'https://example.netlify.app/.netlify/functions/whatsapp-webhook';

  function computeSignature(url, params, token) {
    const crypto = require('node:crypto');
    const sortedKeys = Object.keys(params).sort();
    const data = sortedKeys.reduce((acc, key) => acc + key + params[key], url);
    return crypto.createHmac('sha1', token).update(data).digest('base64');
  }

  it('accepts valid signature', () => {
    const params = { From: 'whatsapp:+1234567890', Body: 'hello', NumMedia: '0' };
    const sig = computeSignature(URL, params, AUTH_TOKEN);
    expect(validateTwilioSignature(URL, params, sig, AUTH_TOKEN)).toBe(true);
  });

  it('rejects tampered params', () => {
    const params = { From: 'whatsapp:+1234567890', Body: 'hello', NumMedia: '0' };
    const sig = computeSignature(URL, params, AUTH_TOKEN);
    params.Body = 'tampered';
    expect(validateTwilioSignature(URL, params, sig, AUTH_TOKEN)).toBe(false);
  });

  it('rejects wrong auth token', () => {
    const params = { From: 'whatsapp:+1234567890', Body: '', NumMedia: '1' };
    const sig = computeSignature(URL, params, AUTH_TOKEN);
    expect(validateTwilioSignature(URL, params, sig, 'wrong_token')).toBe(false);
  });

  it('rejects missing signature', () => {
    const params = { From: 'whatsapp:+1234567890' };
    expect(validateTwilioSignature(URL, params, null, AUTH_TOKEN)).toBe(false);
    expect(validateTwilioSignature(URL, params, '', AUTH_TOKEN)).toBe(false);
  });

  it('rejects missing auth token', () => {
    const params = { From: 'whatsapp:+1234567890' };
    expect(validateTwilioSignature(URL, params, 'abc', null)).toBe(false);
  });

  it('handles empty params', () => {
    const params = {};
    const sig = computeSignature(URL, params, AUTH_TOKEN);
    expect(validateTwilioSignature(URL, params, sig, AUTH_TOKEN)).toBe(true);
  });
});

describe('validateMagicBytes', () => {
  it('validates JPEG magic bytes', () => {
    const buf = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(true);
  });

  it('validates PNG magic bytes', () => {
    const buf = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    expect(validateMagicBytes(buf, 'image/png')).toBe(true);
  });

  it('validates WebP magic bytes (RIFF...WEBP)', () => {
    const buf = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(validateMagicBytes(buf, 'image/webp')).toBe(true);
  });

  it('validates PDF magic bytes', () => {
    const buf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0, 0, 0, 0]);
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(true);
  });

  it('rejects mismatched magic bytes (PNG file claimed as JPEG)', () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]);
    expect(validateMagicBytes(pngBytes, 'image/jpeg')).toBe(false);
  });

  it('rejects random garbage bytes', () => {
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0, 0, 0, 0]);
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(false);
    expect(validateMagicBytes(buf, 'image/png')).toBe(false);
    expect(validateMagicBytes(buf, 'application/pdf')).toBe(false);
  });

  it('rejects buffer too short', () => {
    const buf = new Uint8Array([0xFF, 0xD8]);
    expect(validateMagicBytes(buf, 'image/jpeg')).toBe(false);
  });

  it('rejects unknown media type', () => {
    const buf = new Uint8Array(12);
    expect(validateMagicBytes(buf, 'image/gif')).toBe(false);
  });

  it('works with ArrayBuffer input', () => {
    const arr = new ArrayBuffer(12);
    const view = new Uint8Array(arr);
    view.set([0xFF, 0xD8, 0xFF, 0xE1]);
    expect(validateMagicBytes(arr, 'image/jpeg')).toBe(true);
  });
});

describe('escapeXml', () => {
  it('escapes ampersand', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });
  it('escapes angle brackets', () => {
    expect(escapeXml('<script>')).toBe('&lt;script&gt;');
  });
  it('escapes quotes', () => {
    expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
  });
  it('passes through safe text', () => {
    expect(escapeXml('Hello World 123')).toBe('Hello World 123');
  });
});

describe('isAllowedPhone', () => {
  it('allows any phone when list is empty', () => {
    expect(isAllowedPhone('+1234567890', [])).toBe(true);
  });
  it('allows phone in the list', () => {
    expect(isAllowedPhone('+1234567890', ['+1234567890', '+0987654321'])).toBe(true);
  });
  it('rejects phone not in the list', () => {
    expect(isAllowedPhone('+5555555555', ['+1234567890'])).toBe(false);
  });
  it('allows any when list is null/undefined', () => {
    expect(isAllowedPhone('+123', null)).toBe(true);
    expect(isAllowedPhone('+123', undefined)).toBe(true);
  });
});

describe('ALLOWED_MEDIA_TYPES', () => {
  it('includes JPEG, PNG, WebP, PDF', () => {
    expect(ALLOWED_MEDIA_TYPES.has('image/jpeg')).toBe(true);
    expect(ALLOWED_MEDIA_TYPES.has('image/png')).toBe(true);
    expect(ALLOWED_MEDIA_TYPES.has('image/webp')).toBe(true);
    expect(ALLOWED_MEDIA_TYPES.has('application/pdf')).toBe(true);
  });
  it('rejects GIF, HEIC, text', () => {
    expect(ALLOWED_MEDIA_TYPES.has('image/gif')).toBe(false);
    expect(ALLOWED_MEDIA_TYPES.has('image/heic')).toBe(false);
    expect(ALLOWED_MEDIA_TYPES.has('text/plain')).toBe(false);
  });
});
