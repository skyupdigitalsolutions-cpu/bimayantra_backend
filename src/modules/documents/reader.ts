// Reads Aadhaar, PAN and old policy documents with an AI model, so the "Check the details" screen (P-18 step 5)
// opens already filled. A person still checks every value and selects Confirm; nothing is saved before that.
//
// Set in the API's .env (restart the API after changing):
//   OPENAI_API_KEY=sk-...        required; without it the screen opens empty as before (DOC-10)
//   OPENAI_MODEL=gpt-6-astra     optional; any OpenAI model that reads images and PDFs
//   DOC_READER_MOCK=true         optional, for testing without an AI account (returns sample values)
// The file goes to OpenAI only to be read. Aadhaar and PAN numbers are returned to the screen once and are
// never stored as read values (they are stored only after Confirm, encrypted, as before).
import { logger } from '../../lib/logger.js';

export type ReadType = 'Aadhaar' | 'PAN' | 'Old policy';
const AI_URL = 'https://api.openai.com/v1/chat/completions';
const TIMEOUT_MS = 45_000;
const IMAGE = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const SHAPES: Record<ReadType, string> = {
  Aadhaar: `{ "name": string|null, "dateOfBirth": "YYYY-MM-DD"|null, "gender": "MALE"|"FEMALE"|"TRANSGENDER"|null, "aadhaar": "12 digits"|null }`,
  PAN: `{ "name": string|null, "fatherName": string|null, "dateOfBirth": "YYYY-MM-DD"|null, "pan": "ABCDE1234F"|null }`,
  'Old policy': `{ "insurer": string|null, "policyNumber": string|null, "productName": string|null, "startDate": "YYYY-MM-DD"|null,
    "endDate": "YYYY-MM-DD"|null, "sumInsured": number|null, "premium": number|null,
    "insuredPeople": "short list like 'Ravi Kumar (Self, 41), Asha (Spouse, 38)'"|null, "nominees": "short list"|null }`,
};

export const readerConfigured = () => !!process.env.OPENAI_API_KEY?.trim() || process.env.DOC_READER_MOCK === 'true';

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const dmy = (v: unknown) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const text = (v: unknown, max = 300) => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : typeof v === 'number' ? String(v) : '';
  return s ? s.slice(0, max) : null;
};
const amount = (v: unknown) => {
  const n = Number(str(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? String(Math.round(n)) : null;
};

/** Values in the form the verify screen expects (dates DD-MM-YYYY, gender codes, plain amounts). */
function clean(type: ReadType, r: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string | null> = {};
  if (type === 'Aadhaar') {
    out.name = text(r.name, 100);
    out.dateOfBirth = dmy(r.dateOfBirth);
    out.gender = ['MALE', 'FEMALE', 'TRANSGENDER'].includes(String(r.gender)) ? String(r.gender) : null;
    const a = str(r.aadhaar).replace(/\D/g, '');
    out.aadhaar = a.length === 12 ? a : null;
  } else if (type === 'PAN') {
    out.name = text(r.name, 100);
    out.fatherName = text(r.fatherName, 100);
    out.dateOfBirth = dmy(r.dateOfBirth);
    const p = str(r.pan).replace(/\s/g, '').toUpperCase();
    out.pan = /^[A-Z]{5}\d{4}[A-Z]$/.test(p) ? p : null;
  } else {
    out.insurer = text(r.insurer, 120);
    out.policyNumber = text(r.policyNumber, 60);
    out.productName = text(r.productName, 120);
    out.startDate = dmy(r.startDate);
    out.endDate = dmy(r.endDate);
    out.sumInsured = amount(r.sumInsured);
    out.premium = amount(r.premium);
    out.insuredPeople = text(r.insuredPeople, 500);
    out.nominees = text(r.nominees, 500);
  }
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v)) as Record<string, string>;
}

const MOCK: Record<ReadType, Record<string, unknown>> = {
  Aadhaar: { name: 'Ravi Kumar', dateOfBirth: '1985-05-10', gender: 'MALE', aadhaar: '234123412346' },
  PAN: { name: 'RAVI KUMAR', fatherName: 'SURESH KUMAR', dateOfBirth: '1985-05-10', pan: 'ABCPK1234F' },
  'Old policy': { insurer: 'Star Health and Allied Insurance Co. Ltd.', policyNumber: 'P/161100/01/2025/012345', productName: 'Family Health Optima', startDate: '2025-11-01', endDate: '2026-10-31', sumInsured: 500000, premium: 18450, insuredPeople: 'Ravi Kumar (Self, 41), Asha (Spouse, 38)', nominees: 'Asha (Spouse)' },
};

/** Send one image or PDF to the AI with a prompt; the parsed JSON answer, or null (no key, network, unreadable). */
async function askAI(file: Buffer, mime: string, fileName: string, prompt: string): Promise<Record<string, unknown> | null> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) return null;
  const isPdf = mime === 'application/pdf';
  if (!isPdf && !IMAGE.has(mime)) return null;
  const dataUrl = `data:${mime};base64,${file.toString('base64')}`;
  const part = isPdf ? { type: 'file', file: { filename: fileName || 'document.pdf', file_data: dataUrl } } : { type: 'image_url', image_url: { url: dataUrl } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(AI_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL?.trim() || 'gpt-6-astra',
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, part] }],
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: (await res.text()).slice(0, 300) }, 'Document reader: AI request failed');
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Document reader: could not read the document');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Read one document. Returns null when it cannot be read (no key, network, unreadable); never throws. */
export async function readDocument(type: ReadType, file: Buffer, mime: string, fileName: string): Promise<Record<string, string> | null> {
  if (process.env.DOC_READER_MOCK === 'true') return clean(type, MOCK[type]);
  const prompt = `This is an Indian ${type === 'Old policy' ? 'insurance policy document' : `${type} card`}. Extract ONLY what is printed. Never guess; use null when not printed.
Return JSON exactly in this shape: ${SHAPES[type]}`;
  const r = await askAI(file, mime, fileName, prompt);
  return r ? clean(type, r) : null;
}

/** Any customer document → rows for the import sheet. An ID card (Aadhaar, PAN, driving licence, voter ID),
 *  an old policy (the policy holder and insured members) or a list (diary page, register): one row per person.
 *  ID numbers (Aadhaar, PAN) are never returned. */
export async function readCustomerList(file: Buffer, mime: string, fileName: string): Promise<Record<string, string>[] | null> {
  const raw = process.env.DOC_READER_MOCK === 'true'
    ? { customers: [{ fullName: 'Prakash Shetty', mobile: '9741012345', dateOfBirth: '1978-01-20', gender: 'Male', city: 'Udupi', pinCode: '576101' }, { fullName: 'Meena Iyer', dateOfBirth: '1990-11-02', gender: 'Female', city: 'Bengaluru' }] }
    : await askAI(file, mime, fileName, `This image or PDF belongs to an Indian insurance advisor. It is either:
- an ID card of ONE person (Aadhaar, PAN, driving licence, voter ID), or
- an insurance policy document (take the policy holder; add insured family members as more people), or
- a handwritten or printed LIST of customers (diary page, register, sheet).
Read every person. Copy only what is printed or written; never guess; leave a field out when it is not there.
NEVER return Aadhaar, PAN or any ID number.
Return JSON: { "customers": [ { "fullName": string, "mobile": "digits as written", "altMobile": string, "email": string,
"dateOfBirth": "YYYY-MM-DD", "gender": "Male"|"Female"|"Transgender", "addressLine1": string, "city": string, "state": string,
"pinCode": string, "notes": "anything useful written for this person, short" } ] }`);
  if (!raw) return null;
  const list = Array.isArray(raw.customers) ? (raw.customers as Record<string, unknown>[]) : [];
  return list.slice(0, 500).map((c) => {
    const o: Record<string, string> = {};
    for (const k of ['fullName', 'mobile', 'altMobile', 'email', 'gender', 'addressLine1', 'city', 'state', 'pinCode', 'notes'] as const) {
      const v = text(c[k], k === 'notes' ? 300 : 120);
      if (v) o[k] = v.replace(/\b\d{4}\s?\d{4}\s?\d{4}\b/g, '').replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '').trim(); // never an Aadhaar / PAN
      if (!o[k]) delete o[k];
    }
    const dob = dmy(c.dateOfBirth);
    if (dob) o.dateOfBirth = dob;
    return o;
  }).filter((o) => o.fullName || o.mobile);
}

/** An insurer's appointment letter / agent certificate → what is printed on it (for the agent code check).
 *  null when it cannot be read (no key, network, unreadable); never throws. */
export async function readAppointmentLetter(file: Buffer, mime: string, fileName: string): Promise<{ advisorName: string | null; insurerName: string | null; agentCode: string | null; validUntil: string | null } | null> {
  const r = process.env.DOC_READER_MOCK === 'true'
    ? { advisorName: process.env.DOC_READER_MOCK_NAME ?? 'Demo Advisor', insurerName: process.env.DOC_READER_MOCK_INSURER ?? 'Star Health and Allied Insurance Co. Ltd.', agentCode: process.env.DOC_READER_MOCK_CODE ?? 'SH-12345', validUntil: '2028-03-31' }
    : await askAI(file, mime, fileName, `This is an Indian insurance company's appointment letter or agent licence certificate for an insurance agent / POSP.
Copy ONLY what is printed; never guess; use null when it is not printed.
Return JSON exactly in this shape: { "advisorName": "name of the agent / advisor appointed", "insurerName": "insurance company name",
"agentCode": "agent code / licence code / POSP code exactly as printed", "validUntil": "YYYY-MM-DD expiry or valid-up-to date" }`);
  if (!r) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.exec(str(r.validUntil).trim())?.[0] ?? null;
  return { advisorName: text(r.advisorName, 120), insurerName: text(r.insurerName, 160), agentCode: text(r.agentCode, 60), validUntil: iso };
}
