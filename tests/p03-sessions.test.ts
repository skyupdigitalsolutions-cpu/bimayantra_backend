import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { accounts, sessions, users } from '../src/db/schema.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, advance, key, login, newMobile, register, resetClock, resetSettings, userByMobile } from './helpers.js';

beforeAll(async () => {
  await settings.init();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

const cookieValue = (setCookie: string[] | undefined, name: string) =>
  (setCookie ?? []).find((c) => c.startsWith(`${name}=`))?.split(';')[0]?.slice(name.length + 1);

describe('P-03 Session, logout and devices', () => {
  it('AC-P03-1: no activity for CFG-07 ends the session (AUTH-18); the warning time is CFG-123 earlier', async () => {
    const d = new Device();
    await register(d, 'Idle User', newMobile());
    const s = await d.get('/auth/session');
    expect(s.status).toBe(200);
    const idleEnds = new Date(s.body.idleEndsAt).getTime();
    expect(idleEnds - new Date(s.body.warnAt).getTime()).toBe(2 * 60_000);
    expect(s.body.warning.text).toBe('You will be logged out in 2 minutes because of no activity.');

    advance(29 * 60_000);
    expect((await d.get('/auth/session')).status).toBe(200); // the status check is not activity
    advance(2 * 60_000);
    const r = await d.get('/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH-18');
    expect(r.body.error.message).toBe('Your session ended after 30 minutes without activity. Please log in again.');
  });

  it('activity resets the idle timer ("Stay signed in")', async () => {
    const d = new Device();
    await register(d, 'Active User', newMobile());
    advance(25 * 60_000);
    expect((await d.post('/auth/keep-alive')).status).toBe(200);
    advance(25 * 60_000);
    expect((await d.get('/auth/me')).status).toBe(200);
  });

  it('a session lasts at most CFG-08 even with activity', async () => {
    const d = new Device();
    await register(d, 'Long Session', newMobile());
    for (let i = 0; i < 25; i++) {
      advance(29 * 60_000);
      await d.post('/auth/keep-alive');
    }
    const r = await d.get('/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('GEN-09');
  });

  it('AC-P03-2: a form open when the session ends can be submitted after re-verification (same request key)', async () => {
    const d = new Device();
    const m = newMobile();
    await register(d, 'Form Keeper', m);
    advance(31 * 60_000);
    const k = key();
    const first = await d.post('/auth/mobile/send-current-otp', {}, { 'idempotency-key': k });
    expect(first.status).toBe(401);
    await login(d, m);
    const again = await d.post('/auth/mobile/send-current-otp', {}, { 'idempotency-key': k });
    expect(again.status).toBe(200);
  });

  it('AC-P03-3: the (CFG-09 + 1)th login ends the oldest session, which then sees AUTH-17', async () => {
    const m = newMobile();
    const first = new Device();
    await register(first, 'Many Devices', m);
    const others = [new Device(), new Device(), new Device()];
    for (const d of others) {
      advance(1000);
      await login(d, m);
    }
    const r = await first.get('/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH-17');
    for (const d of others) expect((await d.get('/auth/me')).status).toBe(200);
    const list = await others[0]!.get('/auth/sessions');
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.filter((s: { thisDevice: boolean }) => s.thisDevice)).toHaveLength(1);
    expect(list.body.items[0].device).toBe('Chrome on Android');
  });

  it('AC-P03-4: ending a session from the device list stops that device next request (AUTH-22, repeat-safe)', async () => {
    const m = newMobile();
    const phone = new Device();
    const laptop = new Device();
    await register(phone, 'Two Devices', m);
    await login(laptop, m);
    const list = await laptop.get('/auth/sessions');
    const phoneSession = list.body.items.find((s: { thisDevice: boolean }) => !s.thisDevice);
    const end = await laptop.post(`/auth/sessions/${phoneSession.id}/end`);
    expect(end.body.message).toEqual({ code: 'AUTH-22', text: 'The session on Chrome on Android has ended.' });
    expect((await phone.get('/auth/me')).status).toBe(401);
    const again = await laptop.post(`/auth/sessions/${phoneSession.id}/end`);
    expect(again.status).toBe(200);
    expect(again.body.message.code).toBe('AUTH-22');
    // another user's session is "not found" (GR-18)
    const stranger = new Device();
    await register(stranger, 'Stranger', newMobile());
    const r = await stranger.post(`/auth/sessions/${phoneSession.id}/end`);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('GEN-11');
  });

  it('AC-P03-5: disabling a user or suspending the account ends their sessions immediately', async () => {
    const m = newMobile();
    const d = new Device();
    await register(d, 'Soon Suspended', m);
    const u = (await userByMobile(m))!;
    await db.update(accounts).set({ status: 'SUSPENDED' }).where(eq(accounts.id, u.accountId!));
    const r = await d.get('/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH-10');
    const open = await db.select().from(sessions).where(eq(sessions.userId, u.id));
    expect(open.every((s) => s.endedAt !== null)).toBe(true);

    const m2 = newMobile();
    const d2 = new Device();
    await register(d2, 'Soon Disabled', m2);
    const u2 = (await userByMobile(m2))!;
    await db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, u2.id));
    expect((await d2.get('/auth/me')).status).toBe(401);
  });

  it('log out ends the session (AUTH-16) and works when already logged out', async () => {
    const d = new Device();
    await register(d, 'Logging Out', newMobile());
    const r = await d.post('/auth/logout');
    expect(r.body.message).toEqual({ code: 'AUTH-16', text: 'You have logged out.' });
    expect((await d.get('/auth/me')).status).toBe(401);
    expect((await d.post('/auth/logout')).status).toBe(200);
  });

  it('the access token is short-lived; the refresh token rotates and a stolen old one ends the session', async () => {
    const d = new Device();
    const { verify } = await register(d, 'Rotation', newMobile());
    const firstRefresh = cookieValue(verify.headers['set-cookie'] as unknown as string[], 'bm_rt');
    advance(6 * 60_000);
    const r = await d.get('/auth/me');
    expect(r.status).toBe(200);
    const newRefresh = cookieValue(r.headers['set-cookie'] as unknown as string[], 'bm_rt');
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(firstRefresh);

    // An attacker replays the old refresh token after the grace period
    advance(6 * 60_000);
    await d.post('/auth/keep-alive');
    const attacker = new Device();
    const stolen = await attacker.agent.get('/api/v1/auth/me').set('cookie', `bm_rt=${firstRefresh}`).set('x-forwarded-for', attacker.ip);
    expect(stolen.status).toBe(401);
    expect((await d.get('/auth/me')).status).toBe(401); // the whole session ended
  });

  it('not signed in → 401 GEN-09 with the exact message', async () => {
    const r = await new Device().get('/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe('Your session has ended for security. Verify your mobile number to continue. Your entries are kept.');
  });
});
