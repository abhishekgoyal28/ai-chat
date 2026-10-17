import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

/**
 * Small, dependency-free crypto helpers built only on node:crypto primitives.
 * Nothing here invents a cipher: AES-256-GCM for secrets at rest, scrypt for
 * passwords, HMAC-SHA256 for tokens and webhook signatures, HKDF to derive
 * independent keys from one AUTH_SECRET.
 */

/** Independent 32-byte keys from one secret, so a session token can never verify as an admin token. */
export const deriveKey = (secret: string, purpose: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), `ai-chat:${purpose}`, 32));

export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

export const hmacSha256Hex = (key: Buffer | string, value: string): string =>
  createHmac('sha256', key).update(value).digest('hex');

export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

// ---------------------------------------------------------------------------
// Secrets at rest (LLM API keys, FCM credentials, webhook signing secret)
// ---------------------------------------------------------------------------

const SECRET_BOX_VERSION = 'v1';

/**
 * ENCRYPTION_KEY is 32 random bytes, base64-encoded (`openssl rand -base64 32`).
 * Any other length is rejected at boot rather than silently padded.
 */
export const parseEncryptionKey = (encoded: string): Buffer => {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes, base64-encoded (generate with: openssl rand -base64 32)');
  }
  return key;
};

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. The version leaves room for key rotation. */
export const encryptSecret = (plaintext: string, key: Buffer): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [SECRET_BOX_VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
};

export const decryptSecret = (sealed: string, key: Buffer): string => {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== SECRET_BOX_VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('unrecognised encrypted secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
};

/** For display: enough to recognise a key, never enough to use it. */
export const maskSecret = (secret: string): string =>
  secret.length <= 8 ? '••••' : `${secret.slice(0, 4)}••••${secret.slice(-4)}`;

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PASSWORD_KEY_LENGTH = 64;

/** `scrypt$<salt>$<hash>` */
export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, PASSWORD_KEY_LENGTH, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) {
    return false;
  }
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, SCRYPT_PARAMS);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
