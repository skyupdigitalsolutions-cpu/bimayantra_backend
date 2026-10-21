// Optional password login (extra; OTP login stays). Passwords are kept only as a salted scrypt hash.
// Rules (the same list is shown live on the screen): 8 to 64 characters, at least one capital letter,
// one small letter, one number and one symbol; not the mobile number; not a very common password.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((ok, fail) => scryptCb(pw, salt, len, o, (err, key) => (err ? fail(err) : ok(key))));

const N = 16384, R = 8, P = 1, LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// used when there is no user or no password, so a wrong number takes as long as a wrong password
const DUMMY = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function checkPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = (stored || DUMMY).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM });
  return !!stored && got.length === want.length && timingSafeEqual(got, want);
}

const COMMON = new Set(['password', 'password1', 'password@1', 'password@123', 'passw0rd', 'qwerty', 'qwerty@123', 'admin@123', 'welcome@123', 'india@123', 'abc@123', 'abcd@1234', 'test@123', 'pass@123', 'pass@1234', 'iloveyou', 'bimayantra', 'bimayantra@1', 'bimayantra@123', 'skyup@123', 'insurance@123']);

/** The first broken rule as a message ID, or null when the password is fine. */
export function passwordProblem(password: string, mobile?: string | null): string | null {
  if (password.length < 8 || password.length > 64) return 'PWD-01';
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) return 'PWD-01';
  const digits = (mobile ?? '').replace(/\D/g, '').slice(-10);
  if (digits.length === 10 && password.replace(/\D/g, '').includes(digits)) return 'PWD-07';
  if (COMMON.has(password.toLowerCase())) return 'PWD-08';
  return null;
}
