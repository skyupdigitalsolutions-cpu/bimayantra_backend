import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { accounts, advisorKyc, advisorProfiles, pipelines, subscriptions, users, wallets } from '../src/db/schema.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, advance, insertUser, key, lastCode, newMobile, otpCount, register, resetClock, resetSettings, userByMobile, wrongCode } from './helpers.js';

beforeAll(async () => {
  await settings.init();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

describe('P-01 Register as an advisor', () => {
  it('AC-P01-1: valid name, mobile and ticked terms send one OTP and show the masked number', async () => {
    const d = new Device();
    const m = newMobile();
    const res = await d.post('/auth/register/send-otp', { name: 'Asha Rao', mobile: m, termsAccepted: true });
    expect(res.status).toBe(200);
    expect(res.body.maskedMobile).toBe(`${m.slice(0, 2)}XXXXXX${m.slice(-2)}`);
    expect(res.body.message.code).toBe('AUTH-01');
    expect(res.body.message.text).toContain('6-digit code');
    expect(res.body.resendAfterSeconds).toBe(30);
    expect(otpCount(m)).toBe(1);
  });

  it('AC-P01-2: the correct code creates exactly one account with TRIAL, ₹0 wallet and CFG-169 pipelines', async () => {
    const d = new Device();
    const m = newMobile();
    const { verify } = await register(d, 'Asha Rao', m);
    expect(verify.status).toBe(200);
    expect(verify.body.message).toEqual({ code: 'AUTH-15', text: 'Welcome to Bimayantra, Asha Rao. Your 7-day free trial has started.' });
    expect(verify.body.redirectTo).toBe('/dashboard');
    expect(String(verify.headers['set-cookie'])).toMatch(/bm_at=.*HttpOnly/);

    const u = (await userByMobile(m))!;
    expect(u.role).toBe('ADV');
    expect(u.status).toBe('ACTIVE');
    expect(u.termsVersion).toBeTruthy();
    expect(u.termsAcceptedAt).toBeInstanceOf(Date);
    const acc = await db.select().from(accounts).where(eq(accounts.id, u.accountId!));
    expect(acc[0]!.status).toBe('ACTIVE');
    const subs = await db.select().from(subscriptions).where(eq(subscriptions.accountId, u.accountId!));
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ status: 'TRIAL', plan: null, isCurrent: true });
    const w = await db.select().from(wallets).where(eq(wallets.accountId, u.accountId!));
    expect(w[0]!.balance).toBe('0.00');
    const p = await db.select().from(pipelines).where(eq(pipelines.accountId, u.accountId!));
    expect(p.map((x) => x.name).sort()).toEqual([...settings.get('CFG-169')].sort());
    const prof = await db.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, u.accountId!));
    expect(prof[0]!.fullName).toBe('Asha Rao');
    const kyc = await db.select().from(advisorKyc).where(eq(advisorKyc.accountId, u.accountId!));
    expect(kyc[0]!.status).toBe('NOT_SUBMITTED');
  });

  it('AC-P01-3: a wrong code shows AUTH-02 with tries left; after CFG-03 wrong tries AUTH-04 and the number is locked', async () => {
    const d = new Device();
    const m = newMobile();
    const send = await d.post('/auth/register/send-otp', { name: 'Ravi Kumar', mobile: m, termsAccepted: true });
    const bad = wrongCode(lastCode(m));
    for (let left = 4; left >= 1; left--) {
      const r = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code: bad }, { 'idempotency-key': key() });
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('AUTH-02');
      expect(r.body.error.message).toBe(`The code is incorrect. You have ${left} tries left.`);
    }
    const fifth = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code: bad }, { 'idempotency-key': key() });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe('AUTH-04');
    expect(fifth.body.error.message).toMatch(/try again after \d{2}:\d{2} (AM|PM) IST\.$/);
    // Locked: even the right code and a new send are refused for CFG-06
    const again = await d.post('/auth/register/send-otp', { name: 'Ravi Kumar', mobile: m, termsAccepted: true });
    expect(again.status).toBe(429);
    expect(again.body.error.code).toBe('AUTH-04');
    advance(31 * 60_000);
    const later = await d.post('/auth/register/send-otp', { name: 'Ravi Kumar', mobile: m, termsAccepted: true });
    expect(later.status).toBe(200);
    expect(await userByMobile(m)).toBeUndefined();
  });

  it('AC-P01-4: an expired code shows AUTH-03 and creates nothing', async () => {
    const d = new Device();
    const m = newMobile();
    const send = await d.post('/auth/register/send-otp', { name: 'Meena Iyer', mobile: m, termsAccepted: true });
    advance(5 * 60_000 + 1000);
    const r = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(m) }, { 'idempotency-key': key() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('AUTH-03');
    expect(await userByMobile(m)).toBeUndefined();
  });

  it('AC-P01-5: resend inside CFG-04 shows AUTH-05 (no new SMS); the (CFG-05 + 1)th send in 60 minutes shows AUTH-06', async () => {
    const d = new Device();
    const m = newMobile();
    const body = { name: 'Kiran Shetty', mobile: m, termsAccepted: true };
    const first = await d.post('/auth/register/send-otp', body);
    const quick = await d.post('/auth/register/send-otp', body);
    expect(quick.status).toBe(200);
    expect(quick.body.resent).toBe(false);
    expect(quick.body.message.code).toBe('AUTH-05');
    expect(quick.body.challengeId).toBe(first.body.challengeId);
    expect(otpCount(m)).toBe(1);
    for (let i = 2; i <= 5; i++) {
      advance(31_000);
      const r = await d.post('/auth/register/send-otp', body);
      expect(r.body.resent).toBe(true);
    }
    expect(otpCount(m)).toBe(5);
    advance(31_000);
    const sixth = await d.post('/auth/register/send-otp', body);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('AUTH-06');
    expect(otpCount(m)).toBe(5);
  });

  it('AC-P01-6: two quick Verify requests create one account (same key → GEN-06; parallel keys → one account)', async () => {
    const d = new Device();
    const m = newMobile();
    const send = await d.post('/auth/register/send-otp', { name: 'Lata Naik', mobile: m, termsAccepted: true });
    const k = key();
    const payload = { challengeId: send.body.challengeId, code: lastCode(m) };
    const [a, b] = await Promise.all([
      d.post('/auth/register/verify', payload, { 'idempotency-key': k }),
      d.post('/auth/register/verify', payload, { 'idempotency-key': key() }),
    ]);
    expect([a.status, b.status].filter((s) => s === 200)).toHaveLength(1);
    const replay = await d.post('/auth/register/verify', payload, { 'idempotency-key': a.status === 200 ? k : (b.request as unknown as { header: Record<string, string> }).header['idempotency-key']! });
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('GEN-06');
    expect(replay.body.error.result.user.role).toBe('ADV');
    const n = await db.select({ c: sql<number>`count(*)::int` }).from(users).where(eq(users.mobile, `+91${m}`));
    expect(n[0]!.c).toBe(1);
  });

  it('AC-P01-7: registering an existing advisor signs them in without changing the name (AUTH-07)', async () => {
    const m = newMobile();
    await register(new Device(), 'Original Name', m);
    const { verify } = await register(new Device(), 'Other Name', m);
    expect(verify.status).toBe(200);
    expect(verify.body.message.code).toBe('AUTH-07');
    expect((await userByMobile(m))!.name).toBe('Original Name');
  });

  it('AC-P01-8: a number used by REF, STF or ADM creates nothing and shows AUTH-08', async () => {
    for (const role of ['REF', 'STF', 'ADM'] as const) {
      const m = newMobile();
      await insertUser({ role, mobile: m });
      const { verify } = await register(new Device(), 'Someone New', m);
      expect(verify.status).toBe(409);
      expect(verify.body.error.code).toBe('AUTH-08');
      expect((await userByMobile(m))!.role).toBe(role);
    }
  });

  it('AC-P01-9: unticked terms block with VAL-29; two bad fields give GEN-02', async () => {
    const d = new Device();
    const r = await d.post('/auth/register/send-otp', { name: 'Asha Rao', mobile: newMobile() });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('VAL-29');
    expect(r.body.error.fields[0]).toMatchObject({ field: 'termsAccepted', code: 'VAL-29', message: 'Tick this box to continue.' });
    const two = await d.post('/auth/register/send-otp', { name: '', mobile: '123', termsAccepted: true });
    expect(two.body.error.code).toBe('GEN-02');
    expect(two.body.error.message).toBe('Please correct the 2 highlighted fields.');
    expect(two.body.error.fields.map((f: { code: string }) => f.code)).toEqual(['GEN-01', 'VAL-01']);
    expect(two.body.error.fields[0].message).toBe('Full name is required.');
  });

  it('AC-P01-10: the plain OTP never appears in the database or responses', async () => {
    const d = new Device();
    const m = newMobile();
    const send = await d.post('/auth/register/send-otp', { name: 'Code Check', mobile: m, termsAccepted: true });
    const code = lastCode(m);
    const verify = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code }, { 'idempotency-key': key() });
    expect(JSON.stringify(send.body)).not.toContain(code);
    expect(JSON.stringify(verify.body)).not.toContain(code);
    for (const table of ['otp_challenges', 'audit_log', 'idempotency_keys']) {
      const rows = await db.execute(sql.raw(`select row_to_json(t)::text as j from ${table} t`));
      for (const r of rows.rows as { j: string }[]) {
        if (r.j.includes(send.body.challengeId)) expect(r.j).not.toContain(`"${code}"`);
      }
    }
  });

  it('AC-P01-11: an incomplete profile does not block the first dashboard', async () => {
    const d = new Device();
    await register(d, 'New Advisor', newMobile());
    const me = await d.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.home).toBe('/dashboard');
    expect(me.body.readOnly).toBe(false);
    expect(me.body.subscription).toMatchObject({ status: 'TRIAL', plan: null, daysLeft: 7 });
  });

  it('SMS provider failure shows AUTH-13 and does not count towards CFG-05', async () => {
    const { sms } = await import('../src/modules/sms/sms.js');
    const { SmsSendError } = await import('../src/modules/sms/sms.js');
    const spy = vi.spyOn(sms, 'send').mockRejectedValueOnce(new SmsSendError('down'));
    const m = newMobile();
    const r = await new Device().post('/auth/register/send-otp', { name: 'Sms Down', mobile: m, termsAccepted: true });
    spy.mockRestore();
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('AUTH-13');
    const ok = await new Device().post('/auth/register/send-otp', { name: 'Sms Down', mobile: m, termsAccepted: true });
    expect(ok.status).toBe(200);
    expect(ok.body.resent).toBe(true);
  });

  it('CFG-10: more than 20 registration/login requests from one IP in an hour are refused with GEN-15', async () => {
    const d = new Device();
    for (let i = 0; i < 20; i++) await d.post('/auth/login/send-otp', { mobile: newMobile() });
    const r = await d.post('/auth/login/send-otp', { mobile: newMobile() });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('GEN-15');
    expect(r.headers['retry-after']).toBeDefined();
  });

  it('Change number link cancels the open challenge (REPLACED)', async () => {
    const d = new Device();
    const m = newMobile();
    const send = await d.post('/auth/register/send-otp', { name: 'Change Number', mobile: m, termsAccepted: true });
    await d.post('/auth/otp/cancel', { challengeId: send.body.challengeId });
    const r = await d.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(m) }, { 'idempotency-key': key() });
    expect(r.body.error.code).toBe('AUTH-03');
  });
});
