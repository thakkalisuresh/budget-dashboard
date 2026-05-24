import { describe, it, expect } from 'vitest';
import { derivePinKey, aesEncrypt, aesDecrypt } from '../PinLock.jsx';

describe('PIN crypto round-trip', () => {
  const pin = '123456';
  const salt = crypto.getRandomValues(new Uint8Array(32));

  it('derives a CryptoKey from PIN + salt', async () => {
    const key = await derivePinKey(pin, salt);
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
  });

  it('encrypts and decrypts back to the same plaintext', async () => {
    const key = await derivePinKey(pin, salt);
    const plaintext = 'ya29.google-access-token-here';
    const enc = await aesEncrypt(key, plaintext);

    expect(enc.iv).toBeTruthy();
    expect(enc.ct).toBeTruthy();
    expect(enc.ct).not.toBe(plaintext);

    const decrypted = await aesDecrypt(key, enc);
    expect(decrypted).toBe(plaintext);
  });

  it('fails to decrypt with a different PIN', async () => {
    const key1 = await derivePinKey(pin, salt);
    const key2 = await derivePinKey('654321', salt);
    const enc = await aesEncrypt(key1, 'secret');
    const result = await aesDecrypt(key2, enc);
    expect(result).toBeNull();
  });

  it('fails to decrypt with a different salt', async () => {
    const salt2 = crypto.getRandomValues(new Uint8Array(32));
    const key1 = await derivePinKey(pin, salt);
    const key2 = await derivePinKey(pin, salt2);
    const enc = await aesEncrypt(key1, 'secret');
    const result = await aesDecrypt(key2, enc);
    expect(result).toBeNull();
  });

  it('produces different ciphertext each time (random IV)', async () => {
    const key = await derivePinKey(pin, salt);
    const enc1 = await aesEncrypt(key, 'same');
    const enc2 = await aesEncrypt(key, 'same');
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.ct).not.toBe(enc2.ct);
  });
});
