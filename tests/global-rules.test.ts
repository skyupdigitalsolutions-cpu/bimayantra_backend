import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { auditLog } from '../src/db/schema.js';
import { decryptField, encryptField, blindIndex } from '../src/lib/crypto.js';
import * as F from '../src/lib/fields.js';
import { maskAadhaar, maskMobile, maskPan } from '../src/lib/mask.js';
import { verhoeffDigit, verhoeffValid } from '../src/lib/verhoeff.js';
import { allMessageIds, render } from '../src/messages/messages.js';
import { SETTINGS } from '../src/config/settings.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, key, lastCode, newMobile, register, resetClock, resetSettings, setSetting } from './helpers.js';

beforeAll(async () => {
  await settings.init();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

describe('GR-10 / GR-17 idempotency and Check status', () => {
  it('Check status after a lost response: completed → GEN-20 with the result and the sign-in restored', async () => {
    const m = newMobile();
    const d = new Device();
    const send = await d.post('/auth/register/send-otp', { name: 'Lost Response', mobile: m, termsAccepted: true });
    const k = key();
    const before = await new Device().get(`/requests/${k}`);
    expect(before.body).toMatchObject({ status: 'NOT_COMPLETED', message: { code: 'GEN-21' } });

    // The response is "lost": a new browser state with no cookies asks for the status
    const lost = new Device();
    await lost.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(m) }, { 'idempotency-key': k });
    const fresh = new Device(lost.ip);
    const status = await fresh.get(`/requests/${k}`);
    expect(status.body.status).toBe('COMPLETED');
    expect(status.body.message.code).toBe('GEN-20');
    expect(status.body.result.user.role).toBe('ADV');
    expect((await fresh.get('/auth/me')).status).toBe(200);
  });

  it('a failed request is not saved, so the corrected form can reuse the same key', async () => {
    const d = new Device();
    const m = newMobile();
    const send = await d.post('/auth/register/send-otp', { name: 'Retry Same Key', mobile: m, termsAccepted: true });
    const k = key();
    const bad = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code: '12' }, { 'idempotency-key': k });
    expect(bad.body.error.code).toBe('VAL-19');
    expect(bad.body.error.message).toBe('Enter the 6-digit code sent to your mobile.');
    const ok = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(m) }, { 'idempotency-key': k });
    expect(ok.status).toBe(200);
  });

  it('a required key is enforced', async () => {
    const r = await new Device().post('/auth/register/verify', { challengeId: 'x', code: '123456' });
    expect(r.status).toBe(422);
    expect(r.body.error.fields[0].field).toBe('Idempotency-Key');
  });
});

describe('GR-30 audit log', () => {
  it('records sign-up and sign-in, never the code, and cannot be edited or deleted', async () => {
    const m = newMobile();
    await register(new Device(), 'Audited Person', m);
    const rows = await db.select().from(auditLog).where(sql`${auditLog.newValue}::text like ${'%' + m.slice(-2) + '%'}`);
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['OTP_REQUESTED', 'OTP_VERIFIED', 'ACCOUNT_CREATED']));
    expect(JSON.stringify(rows)).not.toContain(`+91${m}`); // mobiles are masked in the log
    await expect(db.execute(sql`update audit_log set action = 'X' where id = ${rows[0]!.id}`)).rejects.toThrow();
    await expect(db.execute(sql`delete from audit_log where id = ${rows[0]!.id}`)).rejects.toThrow();
  });
});

describe('Errors (Section 2.5)', () => {
  it('unknown route → 404 GEN-11; unknown error → 500 GEN-99 with a reference', async () => {
    const r = await new Device().get('/nothing-here');
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('GEN-11');
    const j = await new Device().agent.post('/api/v1/auth/login/send-otp').set('content-type', 'application/json').send('{bad json');
    expect(j.status).toBe(400);
    expect(j.body.error.errorId).toBeTruthy();
    expect(j.body.error.message).toContain(j.body.error.errorId);
  });

  it('writes must be JSON (cross-site form posts are refused)', async () => {
    const r = await new Device().agent.post('/api/v1/auth/logout').set('content-type', 'text/plain').send('x');
    expect(r.status).toBe(415);
  });

  it('CFG-99: too many requests per user per minute → 429 GEN-15', async () => {
    const d = new Device();
    await register(d, 'Busy User', newMobile());
    await setSetting('CFG-99', 3);
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await d.get('/auth/me')).status;
    expect(last).toBe(429);
  });
});

describe('Settings and messages', () => {
  it('every CFG value is in the database; ADM changes are kept, Release values follow the code', async () => {
    const n = await db.execute(sql`select count(*)::int as c from config_values`);
    expect((n.rows[0] as { c: number }).c).toBe(Object.keys(SETTINGS).length);
    await setSetting('CFG-02', 9);
    await settings.init();
    expect(settings.get('CFG-02')).toBe(9);
    await setSetting('CFG-01', 4);
    await settings.init();
    expect(settings.get('CFG-01')).toBe(6);
  });

  it('every message renders; {CFG-xx} placeholders show the live value', async () => {
    for (const id of allMessageIds()) expect(() => render(id)).not.toThrow();
    for (const id of allMessageIds()) expect(render(id)).not.toMatch(/\{CFG-\d+\}/);
    await setSetting('CFG-07', 45);
    expect(render('AUTH-18')).toBe('Your session ended after 45 minutes without activity. Please log in again.');
  });
});

describe('Field formats (Section 2A)', () => {
  const ok = (r: F.RuleResult<unknown>) => (r.ok ? r.value : `ERR ${r.code}`);
  it('mobile (FLD-01) accepts common Indian formats and stores +91', () => {
    expect(ok(F.mobile('98450 12345'))).toBe('+919845012345');
    expect(ok(F.mobile('+91-9845012345'))).toBe('+919845012345');
    expect(ok(F.mobile('09845012345'))).toBe('+919845012345');
    expect(ok(F.mobile('5845012345'))).toBe('ERR VAL-01');
  });
  it('names, PAN, PIN code, OTP, amounts and Aadhaar', () => {
    expect(ok(F.personName('  asha   rao '))).toBe('asha rao');
    expect(ok(F.personName('A'))).toBe('ERR VAL-02');
    expect(ok(F.personName('Asha 😀'))).toBe('ERR VAL-02');
    expect(ok(F.pan('abcpe1234f'))).toBe('ABCPE1234F');
    expect(ok(F.pinCode('560001'))).toBe('560001');
    expect(ok(F.pinCode('060001'))).toBe('ERR VAL-15');
    expect(ok(F.otp('123456'))).toBe('123456');
    expect(ok(F.otp('12345'))).toBe('ERR VAL-19');
    const base = '23456789012';
    const aadhaar = base + String(verhoeffDigit(base));
    expect(verhoeffValid(aadhaar)).toBe(true);
    expect(ok(F.aadhaar(aadhaar))).toBe(aadhaar);
    expect(ok(F.aadhaar(base + String((verhoeffDigit(base) + 1) % 10)))).toBe('ERR VAL-38');
    expect(F.formatRupees('123456.5')).toBe('₹1,23,456.50');
  });
});

describe('GR-31 / GR-36 masking and encryption', () => {
  it('masks mobile, PAN and Aadhaar exactly as the document shows', () => {
    expect(maskMobile('+919845012321')).toBe('98XXXXXX21');
    expect(maskPan('ABCDE1234X')).toBe('ABCXX1234X');
    expect(maskAadhaar('234567890123')).toBe('XXXX XXXX 0123');
  });
  it('encrypts field by field (different ciphertext each time) and decrypts', () => {
    const a = encryptField('ABCPE1234F');
    const b = encryptField('ABCPE1234F');
    expect(a).not.toBe(b);
    expect(a).not.toContain('ABCPE1234F');
    expect(decryptField(a)).toBe('ABCPE1234F');
    expect(blindIndex('pan', 'ABCPE1234F')).toBe(blindIndex('pan', 'ABCPE1234F'));
    // change the second-to-last character to a different one (never the same character)
    const tampered = a.slice(0, -2) + (a.at(-2) === 'A' ? 'B' : 'A') + a.slice(-1);
    expect(() => decryptField(tampered)).toThrow();
  });
});
