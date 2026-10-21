import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/client.js';
import { consumeStepUp } from '../src/modules/auth/auth.service.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { sentSms } from '../src/modules/sms/sms.js';
import { Device, insertUser, key, lastCode, login, newMobile, register, resetClock, resetSettings, userByMobile, wrongCode } from './helpers.js';

beforeAll(async () => {
  await settings.init();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

async function verifyCurrent(d: Device, mobile: string) {
  const s = await d.post('/auth/mobile/send-current-otp');
  expect(s.status).toBe(200);
  const v = await d.post('/auth/mobile/verify-current', { challengeId: s.body.challengeId, code: lastCode(mobile) });
  expect(v.status).toBe(200);
  return v.body.ticketId as string;
}

describe('P-04 Change registered mobile number', () => {
  it('AC-P04-1 and AC-P04-3: both OTPs are needed; the number changes only after the second; other sessions end', async () => {
    const oldM = newMobile();
    const newM = newMobile();
    const d = new Device();
    const other = new Device();
    await register(d, 'Changing Number', oldM);
    await login(other, oldM);

    const ticketId = await verifyCurrent(d, oldM);
    expect((await userByMobile(oldM))).toBeDefined();
    const send = await d.post('/auth/mobile/send-new-otp', { ticketId, newMobile: newM });
    expect(send.status).toBe(200);
    // a wrong code on the new number keeps the old one
    const bad = await d.post('/auth/mobile/verify-new', { challengeId: send.body.challengeId, code: wrongCode(lastCode(newM)) }, { 'idempotency-key': key() });
    expect(bad.body.error.code).toBe('AUTH-02');
    expect(await userByMobile(oldM)).toBeDefined();

    const ok = await d.post('/auth/mobile/verify-new', { challengeId: send.body.challengeId, code: lastCode(newM) }, { 'idempotency-key': key() });
    expect(ok.status).toBe(200);
    expect(ok.body.message).toEqual({
      code: 'AUTH-23',
      text: `Your mobile number is now ${newM.slice(0, 2)}XXXXXX${newM.slice(-2)}. Use it from your next login.`,
    });
    expect(await userByMobile(oldM)).toBeUndefined();
    expect((await userByMobile(newM))!.name).toBe('Changing Number');
    expect((await d.get('/auth/me')).status).toBe(200);
    expect((await other.get('/auth/me')).status).toBe(401);
    expect(sentSms.some((s) => s.kind === 'MOBILE_CHANGED' && s.to === `+91${oldM}`)).toBe(true);
    // the new number logs in
    expect((await login(new Device(), newM)).verify.status).toBe(200);
  });

  it('the new-number step needs the verified current number first', async () => {
    const d = new Device();
    await register(d, 'No Ticket', newMobile());
    const r = await d.post('/auth/mobile/send-new-otp', { ticketId: '00000000-0000-4000-8000-000000000000', newMobile: newMobile() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('GEN-04');
  });

  it('AC-P04-2: a number used by any other user is refused with AUTH-25; the same number with AUTH-24', async () => {
    const m = newMobile();
    const taken = newMobile();
    await insertUser({ role: 'STF', mobile: taken });
    const d = new Device();
    await register(d, 'Taken Check', m);
    const ticketId = await verifyCurrent(d, m);
    const same = await d.post('/auth/mobile/send-new-otp', { ticketId, newMobile: m });
    expect(same.body.error.code).toBe('AUTH-24');
    expect(same.body.error.message).toBe('This is already your registered number.');
    const used = await d.post('/auth/mobile/send-new-otp', { ticketId, newMobile: taken });
    expect(used.body.error.code).toBe('AUTH-25');
  });

  it('the unique rule refuses a number taken between the OTP and the change (GR-12)', async () => {
    const m = newMobile();
    const target = newMobile();
    const d = new Device();
    await register(d, 'Race Check', m);
    const ticketId = await verifyCurrent(d, m);
    const send = await d.post('/auth/mobile/send-new-otp', { ticketId, newMobile: target });
    const code = lastCode(target);
    await register(new Device(), 'Faster Person', target);
    const r = await d.post('/auth/mobile/verify-new', { challengeId: send.body.challengeId, code }, { 'idempotency-key': key() });
    expect(r.body.error.code).toBe('AUTH-25');
    expect((await userByMobile(m))!.name).toBe('Race Check');
  });
});

describe('Step-up OTP (CFG-83, AUTH-26)', () => {
  it('a sensitive action needs a fresh, single-use OTP token for that action', async () => {
    const m = newMobile();
    await insertUser({ role: 'ADM', mobile: m, name: 'Admin One' });
    const d = new Device();
    await login(d, m);
    const send = await d.post('/auth/step-up/send-otp', { action: 'PUBLISH' });
    expect(send.body.prompt.code).toBe('AUTH-26');
    const bad = await d.post('/auth/step-up/verify', { challengeId: send.body.challengeId, code: wrongCode(lastCode(m)) });
    expect(bad.body.error.code).toBe('AUTH-02');
    const ok = await d.post('/auth/step-up/verify', { challengeId: send.body.challengeId, code: lastCode(m) });
    expect(ok.status).toBe(200);

    const u = (await userByMobile(m))!;
    const me = await d.get('/auth/sessions');
    const sessionId = me.body.items.find((s: { thisDevice: boolean }) => s.thisDevice).id as string;
    const auth = { userId: u.id, sessionId, role: 'ADM' as const, accountId: null, name: u.name, mobile: u.mobile, readOnly: false };
    await expect(consumeStepUp(db, auth, ok.body.stepUpToken, 'APPROVE')).rejects.toMatchObject({ code: 'AUTH-26' });
    await expect(consumeStepUp(db, auth, undefined, 'PUBLISH')).rejects.toMatchObject({ code: 'AUTH-26' });
    await expect(consumeStepUp(db, auth, ok.body.stepUpToken, 'PUBLISH')).resolves.toEqual(expect.any(String));
    await expect(consumeStepUp(db, auth, ok.body.stepUpToken, 'PUBLISH')).rejects.toMatchObject({ code: 'AUTH-26' });
  });
});
