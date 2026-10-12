import { describe, it, expect } from 'vitest';
import { encryptCredentials, decryptCredentials, encryptKeys, decryptKeys } from '../lib/crypto';

describe('P2b Supplier Credentials & Keys Encryption (AES-256-GCM)', () => {
  it('encrypts and decrypts supplier credentials object roundtrip', () => {
    const originalCredentials = {
      apiKey: 'test-secret-api-key-12345',
      secretKey: 'top-secret-98765',
      partnerId: 42,
    };

    const encrypted = encryptCredentials(originalCredentials);
    expect(typeof encrypted).toBe('string');
    expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:encrypted

    const decrypted = decryptCredentials<typeof originalCredentials>(encrypted);
    expect(decrypted).toEqual(originalCredentials);
  });

  it('encrypts and decrypts supplier credentials raw string roundtrip', () => {
    const rawSecret = 'Bearer some-jwt-or-bearer-token-string';

    const encrypted = encryptCredentials(rawSecret);
    const decrypted = decryptCredentials<string>(encrypted);
    expect(decrypted).toBe(rawSecret);
  });

  it('fails decryption gracefully if encrypted string format is malformed', () => {
    expect(() => decryptCredentials('malformed-string')).toThrow('Invalid encrypted credentials format');
  });

  it('fails decryption if authTag or payload is tampered', () => {
    const encrypted = encryptCredentials({ secret: 'hello' });
    const parts = encrypted.split(':');
    // Tamper the ciphertext
    const tampered = `${parts[0]}:${parts[1]}:tampered${parts[2]}`;
    expect(() => decryptCredentials(tampered)).toThrow();
  });

  it('preserves existing encryptKeys and decryptKeys behavior', () => {
    const keys = ['KEY-1', 'KEY-2', 'KEY-3'];
    const encrypted = encryptKeys(keys);
    const decrypted = decryptKeys(encrypted);
    expect(decrypted).toEqual(keys);
  });
});
