// Hashing, random tokens and field encryption.
// GR-36 / NFR-07: PAN and Aadhaar are encrypted field by field with AES-256-GCM. A keyed hash
// ("blind index") lets the database enforce uniqueness and find a value without decrypting.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const masterKey = Buffer.from(env.FIELD_ENCRYPTION_KEY, 'base64');
const encKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'bimayantra field encryption v1', 32));
const indexKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'bimayantra blind index v1', 32));

export function hmac(secret: string | Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Constant-time comparison of two strings (GR: compare OTP codes in constant time). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep the timing similar
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Salted OTP hash: the challenge ID is the salt, the server secret the key. The code itself is never stored. */
export function hashOtp(challengeId: string, code: string): string {
  return hmac(env.OTP_SECRET, `${challengeId}:${code}`);
}

export function randomDigits(length: number): string {
  return String(randomInt(0, 10 ** length)).padStart(length, '0');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Hash for refresh tokens and other bearer secrets kept in the database. */
export function hashToken(token: string): string {
  return hmac(env.JWT_ACCESS_SECRET, `token:${token}`);
}

const PREFIX = 'v1';
export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function decryptField(stored: string): string {
  const [prefix, iv, tag, ct] = stored.split(':');
  if (prefix !== PREFIX || !iv || !tag || ct === undefined) throw new Error('Unknown encrypted field format');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** Like decryptField, but null when the value was encrypted with another key (e.g. a lost .env on an old
 *  computer), so one unreadable old value never breaks a whole screen. */
export function tryDecryptField(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    return decryptField(stored);
  } catch {
    return null;
  }
}

/** Keyed hash of a normalised identity number, for unique rules and lookups. */
export function blindIndex(kind: string, value: string): string {
  return hmac(indexKey, `${kind}:${value}`);
}
