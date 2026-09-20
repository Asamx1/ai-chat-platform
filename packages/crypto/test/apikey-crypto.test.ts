import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
});
afterEach(() => vi.unstubAllEnvs());

describe('API key crypto', () => {
  it('round trips Unicode and empty text with fresh IVs and a v1 envelope', async () => {
    const { encrypt, decrypt } = await import('../src/index');
    for (const plain of ['', 'sk-secret-中文-123456789']) {
      const stored = encrypt(plain);
      expect(stored.split(':')).toHaveLength(4);
      expect(stored.startsWith('v1:')).toBe(true);
      expect(decrypt(stored)).toBe(plain);
      expect(encrypt(plain)).not.toBe(stored);
    }
  });
  it.each([2, 3])('rejects tampering with segment %s', async segment => {
    const { encrypt, decrypt, KeyDecryptError } = await import('../src/index');
    const parts = encrypt('secret').split(':');
    const bytes = Buffer.from(parts[segment]!, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    parts[segment] = bytes.toString('base64');
    expect(() => decrypt(parts.join(':'))).toThrow(KeyDecryptError);
  });
  it.each(['v2:a:b:c', 'v1:a:b', 'v1:!!!!:!!!!:!!!!', 'v1:::'])('rejects malformed ciphertext %s', async stored => {
    const { decrypt, KeyDecryptError } = await import('../src/index');
    expect(() => decrypt(stored)).toThrow(KeyDecryptError);
  });
  it('rejects another master key', async () => {
    const { encrypt } = await import('../src/index');
    const stored = encrypt('secret');
    vi.resetModules();
    vi.stubEnv('ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    const { decrypt, KeyDecryptError } = await import('../src/index');
    expect(() => decrypt(stored)).toThrow(KeyDecryptError);
  });
  it.each([undefined, '', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), 'invalid'])('fails on first use for invalid master %s', async master => {
    vi.stubEnv('ENCRYPTION_KEY', master);
    const { encrypt } = await import('../src/index');
    expect(() => encrypt('x')).toThrow('ENCRYPTION_KEY');
  });
  it('masks first six and last four characters with short-key boundaries', async () => {
    const { maskKey } = await import('../src/index');
    expect(maskKey('12345678901')).toBe('123456…8901');
    for (const key of ['', '123456789', '1234567890']) expect(maskKey(key)).toBe('***');
  });
});
