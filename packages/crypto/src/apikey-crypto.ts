import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { ALG, IV_LEN, TAG_LEN, VERSION } from './constants';

export class KeyDecryptError extends Error {
  constructor() {
    super('API key decryption failed');
    this.name = 'KeyDecryptError';
  }
}

function decode(value: string): Buffer {
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value) throw new Error('Invalid base64');
  return result;
}

function deriveKey(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  let master: Buffer;
  try { master = decode(encoded); } catch {
    throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  if (master.length !== 32) throw new Error('ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  return Buffer.from(hkdfSync('sha256', master, '', 'apikey:v1', 32));
}

// Lazy: build-time page-data collection has no env; first use validates (fail-fast at runtime).
let cachedKey: Buffer | undefined;
function dataKey(): Buffer {
  if (!cachedKey) cachedKey = deriveKey();
  return cachedKey;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, dataKey(), iv, { authTagLength: TAG_LEN });
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decrypt(stored: string): string {
  try {
    const parts = stored.split(':');
    const [version, iv64, tag64, ct64] = parts;
    if (parts.length !== 4 || version !== VERSION || iv64 === undefined || tag64 === undefined || ct64 === undefined) throw new KeyDecryptError();
    const iv = decode(iv64);
    const tag = decode(tag64);
    if (iv.length !== IV_LEN || tag.length !== TAG_LEN) throw new KeyDecryptError();
    const decipher = createDecipheriv(ALG, dataKey(), iv, { authTagLength: TAG_LEN });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(decode(ct64)), decipher.final()]).toString('utf8');
  } catch {
    throw new KeyDecryptError();
  }
}

export function maskKey(plain: string): string {
  return plain.length <= 10 ? '***' : `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}
