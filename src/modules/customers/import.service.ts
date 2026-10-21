// Bulk customers from Excel / CSV. The website reads the sheet and sends the rows here (up to 200 per call).
// check=true: every row is checked with the same rules as "+ Customer" (P-15) and nothing is saved.
// check=false: each valid row is created exactly like "+ Customer"; a row that fails never stops the others.
// The same mobile already in the account (or twice in the file) is skipped, never duplicated.
import type { Request } from 'express';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../messages/messages.js';
import type { AuthContext } from '../../types/express.js';
import { db } from '../../db/client.js';
import { createCustomer, customerDuplicates, parseCustomer } from './customers.service.js';
import { ownFile, readStored } from '../files/files.service.js';
import { readCustomerList, readerConfigured } from '../documents/reader.js';

const MAX_ROWS = 200;
const FIELDS = ['fullName', 'mobile', 'altMobile', 'email', 'dateOfBirth', 'gender', 'addressLine1', 'addressLine2', 'city', 'state', 'pinCode', 'occupation', 'anniversary', 'notes'] as const;
const GENDER: Record<string, string> = { male: 'MALE', m: 'MALE', female: 'FEMALE', f: 'FEMALE', transgender: 'TRANSGENDER', t: 'TRANSGENDER', other: 'TRANSGENDER' };

type RowResult = { row: number; name: string; status: 'OK' | 'POSSIBLE_DUPLICATE' | 'ERROR' | 'SKIPPED' | 'CREATED'; messages: string[]; customerNumber?: string };

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
/** One row as the "+ Customer" form would send it. */
function toBody(raw: Record<string, unknown>) {
  const b: Record<string, string> = {};
  for (const k of FIELDS) {
    const v = str(raw[k]);
    if (v) b[k] = v;
  }
  if (b.mobile) b.mobile = b.mobile.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (b.altMobile) b.altMobile = b.altMobile.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');
  if (b.gender) b.gender = GENDER[b.gender.toLowerCase()] ?? b.gender.toUpperCase();
  if (b.pinCode) b.pinCode = b.pinCode.replace(/\D/g, '');
  return b;
}
const texts = (err: unknown) => {
  if (err instanceof AppError) return err.fields.length ? err.fields.map((f) => msg(f.code, f.params ?? {}).text) : [msg(err.code, err.params).text];
  return ['Could not save this row. Try again.'];
};

export async function importCustomers(req: Request, auth: AuthContext, body: unknown) {
  const b = (body ?? {}) as { rows?: unknown; check?: unknown; startRow?: unknown };
  const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
  if (!rows.length) throw new AppError(422, 'GEN-01', { 'Field label': 'Rows' }, [{ field: 'rows', code: 'GEN-01', params: { 'Field label': 'Rows' } }]);
  if (rows.length > MAX_ROWS) throw new AppError(422, 'VAL-22', {}, [{ field: 'rows', code: 'VAL-22' }]);
  const check = b.check === true;
  const first = Number(b.startRow) || 2; // row 1 is the heading row in Excel
  const seen = new Set<string>();
  const out: RowResult[] = [];
  for (const [i, raw] of rows.entries()) {
    const body1 = toBody(raw ?? {});
    const r: RowResult = { row: Number((raw ?? {})._row) || first + i, name: body1.fullName ?? '', status: 'OK', messages: [] };
    out.push(r);
    try {
      const d = parseCustomer(body1);
      if (seen.has(d.mobile)) {
        r.status = 'SKIPPED';
        r.messages.push('Same mobile number as an earlier row in this file.');
        continue;
      }
      seen.add(d.mobile);
      const dup = await customerDuplicates(db, auth.accountId!, d.mobile, d.fullName);
      if (dup.exact) {
        r.status = 'SKIPPED';
        r.messages.push(`Already a customer: ${dup.exact.number}.`);
        continue;
      }
      if (dup.possible.length) {
        r.status = 'POSSIBLE_DUPLICATE';
        r.messages.push(`Looks like ${dup.possible[0]!.fullName} (${dup.possible[0]!.number}). It is still added; check it later.`);
      }
      if (!check) {
        const res = await createCustomer(req, auth, { ...body1, saveAnyway: true });
        r.status = 'CREATED';
        r.customerNumber = res.customer.number;
      }
    } catch (err) {
      r.status = 'ERROR';
      r.messages.push(...texts(err));
    }
  }
  const count = (s: RowResult['status']) => out.filter((x) => x.status === s).length;
  return {
    rows: out,
    summary: { total: out.length, ok: count('OK') + count('POSSIBLE_DUPLICATE'), created: count('CREATED'), skipped: count('SKIPPED'), errors: count('ERROR') },
  };
}

/** A photo / PDF of a customer list → rows for the same check-and-import screen (nothing is saved here). */
export async function readListPhoto(auth: AuthContext, body: unknown) {
  const f = await ownFile(auth, (body as { fileId?: unknown } | null)?.fileId, ['CLIENT_DOCUMENT'], 'fileId');
  if (!readerConfigured()) return { rows: [], message: 'Reading photos is not set up yet (OPENAI_API_KEY in the API .env). Use phone contacts or Excel for now.' };
  const rows = await readCustomerList(await readStored(f.storageKey), f.mime, f.originalName);
  if (!rows) return { rows: [], message: 'Could not read this photo. Take a clearer, straight photo in good light, or use Excel.' };
  return { rows, message: rows.length ? null : 'No names or mobile numbers were found in this photo.' };
}
