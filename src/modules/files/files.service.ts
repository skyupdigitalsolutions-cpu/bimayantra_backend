// FLD-22 uploads and GR-32 downloads.
// - type checked by content (magic bytes), not the file name; size and count limits from CFG-26/27/28/126/127
// - a PDF that is password-protected or damaged is refused (VAL-26); a virus scan must pass (VAL-27)
// - stored privately (local folder or S3); opened only through a link that expires after CFG-31 and works
//   only for a signed-in user who may see the file
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { files } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';
import { safeEqual } from '../../lib/crypto.js';
import { fieldError } from '../../lib/errors.js';
import { settings } from '../settings/settings.service.js';
import type { AuthContext } from '../../types/express.js';

export type Purpose =
  | 'PROFILE_PHOTO'
  | 'BUSINESS_LOGO'
  | 'KYC_PAN'
  | 'KYC_LICENCE'
  | 'APPOINTMENT_LETTER'
  | 'BROCHURE'
  | 'POLICY_WORDING'
  | 'INSURER_LOGO'
  | 'CORRECTION_EVIDENCE'
  | 'CLIENT_DOCUMENT'
  | 'FAMILY_PHOTO'
  | 'CONSENT_EVIDENCE'
  | 'VEHICLE_PHOTO'
  | 'POLICY_DOCUMENT'
  | 'PAYMENT_RECEIPT'
  | 'ENDORSEMENT'
  | 'TEMPLATE_IMAGE';
/** Files the server makes itself (quotation PDFs, account exports): never uploaded by a user. */
export type GeneratedPurpose = 'QUOTATION_PDF' | 'COMPARISON_PDF' | 'ACCOUNT_EXPORT' | 'AUDIT_EXPORT';
export const PURPOSES: readonly Purpose[] = [
  'PROFILE_PHOTO',
  'BUSINESS_LOGO',
  'KYC_PAN',
  'KYC_LICENCE',
  'APPOINTMENT_LETTER',
  'BROCHURE',
  'POLICY_WORDING',
  'INSURER_LOGO',
  'CORRECTION_EVIDENCE',
  'CLIENT_DOCUMENT',
  'FAMILY_PHOTO',
  'CONSENT_EVIDENCE',
  'VEHICLE_PHOTO',
  'POLICY_DOCUMENT',
  'PAYMENT_RECEIPT',
  'ENDORSEMENT',
  'TEMPLATE_IMAGE',
];
/** Which roles may upload for each purpose. SkyUp uploads are platform files (no account). */
export const UPLOADERS: Record<Purpose, readonly string[]> = {
  PROFILE_PHOTO: ['ADV'],
  BUSINESS_LOGO: ['ADV'],
  KYC_PAN: ['ADV'],
  KYC_LICENCE: ['ADV'],
  APPOINTMENT_LETTER: ['ADV'],
  BROCHURE: ['ADV', 'STF', 'ADM'],
  POLICY_WORDING: ['ADV', 'STF', 'ADM'],
  INSURER_LOGO: ['STF', 'ADM'],
  CORRECTION_EVIDENCE: ['ADV'],
  // Client records (P-16 to P-18, P-54): the advisor and assistants (Section 3.2)
  CLIENT_DOCUMENT: ['ADV', 'AST'],
  FAMILY_PHOTO: ['ADV', 'AST'],
  CONSENT_EVIDENCE: ['ADV', 'AST'],
  VEHICLE_PHOTO: ['ADV', 'AST'],
  // Payments, policies and nominees (P-32 to P-35): the advisor only (Section 3.2)
  POLICY_DOCUMENT: ['ADV'],
  PAYMENT_RECEIPT: ['ADV'],
  ENDORSEMENT: ['ADV'],
  // WhatsApp template header image (P-39)
  TEMPLATE_IMAGE: ['STF', 'ADM'],
};
const IMAGE_ONLY: readonly Purpose[] = ['PROFILE_PHOTO', 'BUSINESS_LOGO', 'INSURER_LOGO', 'FAMILY_PHOTO', 'VEHICLE_PHOTO', 'TEMPLATE_IMAGE'];

type Kind = { ext: 'PDF' | 'JPG' | 'PNG'; mime: string };
function sniff(buf: Buffer): Kind | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'PDF', mime: 'application/pdf' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'JPG', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'PNG', mime: 'image/png' };
  return null;
}

/** A PDF must end properly and must not be encrypted (password-protected). Images must have their end marker. */
function opensCleanly(buf: Buffer, kind: Kind): boolean {
  if (kind.ext === 'PDF') {
    const tail = buf.subarray(Math.max(0, buf.length - 2048)).toString('latin1');
    if (!tail.includes('%%EOF')) return false;
    return !/\/Encrypt\s/.test(buf.toString('latin1'));
  }
  if (kind.ext === 'JPG') return buf.length > 4 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  return buf.subarray(buf.length - 8).toString('latin1').includes('IEND');
}

// ---------- virus scan (ClamAV INSTREAM) ----------
function clamScan(buf: Buffer): Promise<boolean> {
  return new Promise((resolveScan, reject) => {
    const sock = createConnection({ host: env.CLAMAV_HOST, port: env.CLAMAV_PORT });
    let reply = '';
    sock.setTimeout(30_000, () => sock.destroy(new Error('ClamAV timeout')));
    sock.on('connect', () => {
      sock.write('zINSTREAM\0');
      for (let i = 0; i < buf.length; i += 64 * 1024) {
        const chunk = buf.subarray(i, i + 64 * 1024);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(chunk.length);
        sock.write(len);
        sock.write(chunk);
      }
      sock.write(Buffer.alloc(4));
    });
    sock.on('data', (d) => (reply += d.toString()));
    sock.on('end', () => resolveScan(/OK\0?$/.test(reply.trim())));
    sock.on('error', reject);
  });
}

// ---------- storage ----------
const s3 = env.STORAGE_DRIVER === 's3' ? new S3Client({ region: env.S3_REGION, ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT, forcePathStyle: true } : {}) }) : null;
const localPath = (key: string) => {
  const root = resolve(env.UPLOAD_DIR);
  const p = resolve(join(root, key));
  if (!p.startsWith(root)) throw new Error('Bad storage key');
  return p;
};

async function put(key: string, buf: Buffer, mime: string): Promise<void> {
  if (s3) {
    await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: buf, ContentType: mime, ServerSideEncryption: 'AES256' }));
    return;
  }
  const p = localPath(key);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, buf, { flag: 'wx' }); // never overwrite (documents are never replaced in place)
}

export async function readStored(key: string): Promise<Buffer> {
  if (s3) {
    const r = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
  return readFile(localPath(key));
}

export type Upload = { originalname: string; buffer: Buffer; size: number };

/** Check and store files. Field errors use the input name "files" (VAL-23 … VAL-27). */
export async function storeFiles(auth: AuthContext, purpose: Purpose, uploads: Upload[]) {
  if (uploads.length === 0) throw fieldError('files', 'GEN-01', { 'Field label': 'File' });
  if (uploads.length > settings.get('CFG-28')) throw fieldError('files', 'VAL-25');
  const imageOnly = IMAGE_ONLY.includes(purpose);
  const allowed = (imageOnly ? settings.get('CFG-126') : settings.get('CFG-26')).map((t) => (t === 'JPEG' ? 'JPG' : t));
  // A brochure may be larger so it can be read by OCR (FLD-22 with CFG-29, P-22)
  const maxMb = imageOnly ? settings.get('CFG-127') : purpose === 'BROCHURE' ? Math.max(settings.get('CFG-27'), settings.get('CFG-29')) : settings.get('CFG-27');
  const checked = uploads.map((u) => {
    const kind = sniff(u.buffer);
    if (!kind || !allowed.includes(kind.ext)) throw fieldError('files', 'VAL-23', { 'allowed types': [...new Set(allowed)].join(', ') });
    if (u.size > maxMb * 1024 * 1024) throw fieldError('files', 'VAL-24', { 'size limit': maxMb });
    if (!opensCleanly(u.buffer, kind)) throw fieldError('files', 'VAL-26');
    return { u, kind };
  });
  for (const { u } of checked) {
    if (env.SCAN_PROVIDER === 'clamav' && !(await clamScan(u.buffer).catch(() => false))) throw fieldError('files', 'VAL-27');
  }
  const saved = [];
  for (const { u, kind } of checked) {
    const id = randomUUID();
    const key = `${auth.accountId ?? 'platform'}/${purpose.toLowerCase()}/${id}.${kind.ext.toLowerCase()}`;
    await put(key, u.buffer, kind.mime);
    const [row] = await db
      .insert(files)
      .values({
        id,
        accountId: auth.accountId,
        uploadedBy: auth.userId,
        purpose,
        originalName: u.originalname.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || `file.${kind.ext.toLowerCase()}`,
        mime: kind.mime,
        sizeBytes: u.size,
        sha256: createHash('sha256').update(u.buffer).digest('hex'),
        storageKey: key,
        scan: env.SCAN_PROVIDER === 'clamav' ? 'CLEAN' : 'NOT_SCANNED',
        createdAt: clock.now(),
      })
      .returning();
    saved.push(row!);
  }
  return saved.map((f) => ({ id: f.id, name: f.originalName, mime: f.mime, sizeBytes: f.sizeBytes, purpose: f.purpose }));
}

/** Store a file the server built (a quotation PDF, an export). Returns the file ID and SHA-256 checksum. */
export async function storeGenerated(accountId: string | null, userId: string, purpose: GeneratedPurpose, name: string, buf: Buffer, mime: string) {
  const id = randomUUID();
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'application/zip' ? 'zip' : 'csv';
  const key = `${accountId ?? 'platform'}/${purpose.toLowerCase()}/${id}.${ext}`;
  await put(key, buf, mime);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  await db.insert(files).values({ id, accountId, uploadedBy: userId, purpose, originalName: name, mime, sizeBytes: buf.length, sha256, storageKey: key, scan: 'NOT_SCANNED', createdAt: clock.now() });
  return { id, sha256 };
}

export async function getFile(id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
  const [f] = await db.select().from(files).where(eq(files.id, id));
  return f;
}

/**
 * Who may open a file (GR-32). KYC files and appointment letters: the owner advisor and SkyUp reviewers (P-06, agent code check); other account
 * files: the account's advisor and assistants; platform files: everyone signed in.
 */
export function mayOpen(auth: AuthContext, f: { accountId: string | null; purpose: string }): boolean {
  if (f.accountId === null) return true;
  if (f.purpose === 'ACCOUNT_EXPORT') return auth.role === 'ADV' && auth.accountId === f.accountId;
  if (f.purpose === 'AUDIT_EXPORT') return auth.role === 'ADM' || (auth.role === 'ADV' && auth.accountId === f.accountId);
  if (f.purpose.startsWith('KYC_') || f.purpose === 'CORRECTION_EVIDENCE') return (auth.role === 'ADV' && auth.accountId === f.accountId) || auth.role === 'STF' || auth.role === 'ADM';
  if (f.purpose === 'APPOINTMENT_LETTER' && (auth.role === 'STF' || auth.role === 'ADM')) return true; // agent code check
  return (auth.role === 'ADV' || auth.role === 'AST') && auth.accountId === f.accountId;
}

/** A file in the caller's own account with the expected purpose (used when a form refers to an uploaded file). */
export async function ownFile(auth: AuthContext, id: unknown, purposes: readonly string[], field: string) {
  const f = typeof id === 'string' ? await getFile(id) : undefined;
  if (!f || f.accountId !== auth.accountId || !purposes.includes(f.purpose)) throw fieldError(field, 'VAL-22');
  return f;
}

// ---------- short-lived links (CFG-31) ----------
// The link is bound to the user, their session and the file. It opens only while that session is still
// active, so it works for a signed-in user only (GR-32) — also from the phone app, which cannot attach its
// sign-in header when the phone's PDF viewer opens the link.
const sign = (payload: string) => createHmac('sha256', env.JWT_ACCESS_SECRET).update(`file:${payload}`).digest('base64url');

export function fileLink(userId: string, sessionId: string, fileId: string): { url: string; expiresAt: string } {
  const exp = clock.now().getTime() + settings.get('CFG-31') * 60_000;
  const token = `${exp}.${sessionId}.${sign(`${userId}:${sessionId}:${fileId}:${exp}`)}`;
  return { url: `/api/v1/files/${fileId}/content?t=${token}`, expiresAt: new Date(exp).toISOString() };
}

/** Returns the user and session the link was made for, if it is valid and not expired. */
export function readLink(fileId: string, token: unknown, userId: string): { sessionId: string } | null {
  if (typeof token !== 'string') return null;
  const [exp, sessionId, sig] = token.split('.');
  if (!exp || !sessionId || !sig || Number(exp) < clock.now().getTime()) return null;
  return safeEqual(sig, sign(`${userId}:${sessionId}:${fileId}:${exp}`)) ? { sessionId } : null;
}

export function sessionOfLink(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  return parts.length === 3 && /^[0-9a-f-]{36}$/.test(parts[1]!) ? parts[1]! : null;
}
