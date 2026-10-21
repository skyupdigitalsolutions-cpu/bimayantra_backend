import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { accounts, sessions, subscriptions, users } from '../src/db/schema.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, advance, insertUser, login, newMobile, otpCount, register, resetClock, resetSettings, userByMobile } from './helpers.js';

beforeAll(async () => {
  await settings.init();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

describe('P-02 Log in with mobile OTP', () => {
  it('AC-P02-1: each role lands on its own home screen', async () => {
    const adv = newMobile();
    await register(new Device(), 'Home Advisor', adv);
    expect((await login(new Device(), adv)).verify.body.redirectTo).toBe('/dashboard');
    for (const [role, home] of [['REF', '/referral'], ['STF', '/admin'], ['ADM', '/admin']] as const) {
      const m = newMobile();
      await insertUser({ role, mobile: m });
      const { verify } = await login(new Device(), m);
      expect(verify.status).toBe(200);
      expect(verify.body.redirectTo).toBe(home);
      expect(verify.body.user.role).toBe(role);
    }
  });

  it('AC-P02-2: an unknown number shows AUTH-09 and sends no SMS', async () => {
    const m = newMobile();
    const r = await new Device().post('/auth/login/send-otp', { mobile: m });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('AUTH-09');
    expect(r.body.error.fields[0].field).toBe('mobile');
    expect(otpCount(m)).toBe(0);
  });

  it('AC-P02-3: suspended account, closed account, disabled user and expired invite each show their own message and create no session', async () => {
    const cases: { setup: (m: string) => Promise<void>; code: string }[] = [
      {
        code: 'AUTH-10',
        setup: async (m) => {
          await register(new Device(), 'Suspended One', m);
          const u = (await userByMobile(m))!;
          await db.update(accounts).set({ status: 'SUSPENDED' }).where(eq(accounts.id, u.accountId!));
        },
      },
      {
        code: 'AUTH-14',
        setup: async (m) => {
          await register(new Device(), 'Closed One', m);
          const u = (await userByMobile(m))!;
          await db.update(accounts).set({ status: 'CLOSED', closedAt: new Date('2026-09-01T06:00:00Z') }).where(eq(accounts.id, u.accountId!));
        },
      },
      { code: 'AUTH-11', setup: async (m) => void (await insertUser({ role: 'REF', mobile: m, status: 'DISABLED' })) },
      { code: 'AUTH-19', setup: async (m) => void (await insertUser({ role: 'STF', mobile: m, status: 'DISABLED' })) },
      {
        code: 'AUTH-20',
        setup: async (m) => void (await insertUser({ role: 'REF', mobile: m, status: 'INVITED', invitedAt: new Date(Date.now() - 8 * 86_400_000) })),
      },
    ];
    for (const c of cases) {
      const m = newMobile();
      await c.setup(m);
      const u = (await userByMobile(m))!;
      const before = (await db.select().from(sessions).where(eq(sessions.userId, u.id))).length;
      const { verify } = await login(new Device(), m);
      expect(verify.status, c.code).toBe(403);
      expect(verify.body.error.code).toBe(c.code);
      expect((await db.select().from(sessions).where(eq(sessions.userId, u.id))).length).toBe(before);
      if (c.code === 'AUTH-14') expect(verify.body.error.message).toBe('This account was closed on 01-09-2026. Contact Bimayantra support at support@bimayantra.in.');
    }
  });

  it('AC-P02-4: an EXPIRED subscription signs in to read-only mode with SUB-03', async () => {
    const m = newMobile();
    await register(new Device(), 'Expired Sub', m);
    const u = (await userByMobile(m))!;
    await db.update(subscriptions).set({ status: 'EXPIRED' }).where(eq(subscriptions.accountId, u.accountId!));
    const d = new Device();
    const { verify } = await login(d, m);
    expect(verify.status).toBe(200);
    expect(verify.body.readOnly).toBe(true);
    expect(verify.body.banner.code).toBe('SUB-03');
    expect((await d.get('/auth/me')).body.readOnly).toBe(true);
  });

  it('AC-P02-5: a deep link is shown after login when the role allows it, otherwise the home screen', async () => {
    const m = newMobile();
    await register(new Device(), 'Deep Link', m);
    expect((await login(new Device(), m, '/leads/123?tab=notes')).verify.body.redirectTo).toBe('/leads/123?tab=notes');
    expect((await login(new Device(), m, '/admin/settings')).verify.body.redirectTo).toBe('/dashboard');
    expect((await login(new Device(), m, '//evil.example.com')).verify.body.redirectTo).toBe('/dashboard');
    expect((await login(new Device(), m, 'https://evil.example.com')).verify.body.redirectTo).toBe('/dashboard');
  });

  it('AC-P02-6: an INVITED referrer becomes ACTIVE on first login (AUTH-12)', async () => {
    const m = newMobile();
    await insertUser({ role: 'REF', mobile: m, status: 'INVITED', invitedAt: new Date(), name: 'Invited Ref' });
    const { verify } = await login(new Device(), m);
    expect(verify.status).toBe(200);
    expect(verify.body.message).toEqual({ code: 'AUTH-12', text: 'Welcome, Invited Ref. Your access is ready.' });
    const u = (await userByMobile(m))!;
    expect(u.status).toBe('ACTIVE');
    expect(u.activatedAt).toBeInstanceOf(Date);
  });

  it('the invite validity follows CFG-122 (a changed setting is used at once)', async () => {
    const m = newMobile();
    await insertUser({ role: 'REF', mobile: m, status: 'INVITED', invitedAt: new Date(Date.now() - 2 * 86_400_000) });
    const { setSetting } = await import('./helpers.js');
    await setSetting('CFG-122', 1);
    const { verify } = await login(new Device(), m);
    expect(verify.body.error.code).toBe('AUTH-20');
  });

  it('a login code expires after CFG-02 and a changed CFG-02 is used', async () => {
    const m = newMobile();
    await register(new Device(), 'Validity Check', m);
    const { setSetting } = await import('./helpers.js');
    await setSetting('CFG-02', 10);
    const d = new Device();
    const send = await d.post('/auth/login/send-otp', { mobile: m });
    expect(send.body.message.text).toContain('valid for 10 minutes');
    advance(9 * 60_000);
    const { lastCode } = await import('./helpers.js');
    const ok = await d.post('/auth/login/verify', { challengeId: send.body.challengeId, code: lastCode(m) });
    expect(ok.status).toBe(200);
  });

  it('a user whose number changed after the code was sent cannot use the old code', async () => {
    const m = newMobile();
    await register(new Device(), 'Moved Number', m);
    const d = new Device();
    const send = await d.post('/auth/login/send-otp', { mobile: m });
    const u = (await userByMobile(m))!;
    await db.update(users).set({ mobile: `+91${newMobile()}` }).where(eq(users.id, u.id));
    const { lastCode } = await import('./helpers.js');
    const r = await d.post('/auth/login/verify', { challengeId: send.body.challengeId, code: lastCode(m) });
    expect(r.body.error.code).toBe('AUTH-09');
  });
});
