// The mobile app uses the same processes and rules as the website; only the way it holds the session differs
// (tokens in secure storage instead of cookies).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { settings } from '../src/modules/settings/settings.service.js';
import { advance, app, key, lastCode, newMobile, resetClock, resetSettings } from './helpers.js';

beforeAll(async () => {
  await settings.init();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

class Phone {
  readonly ip = `10.200.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  access?: string;
  refresh?: string;
  post(path: string, body: object = {}, headers: Record<string, string> = {}) {
    const r = request(app).post(`/api/v1${path}`).set('x-client', 'mobile').set('x-forwarded-for', this.ip).set('user-agent', 'okhttp/4.12.0').set(headers);
    if (this.access) r.set('authorization', `Bearer ${this.access}`);
    return r.send(body);
  }
  get(path: string) {
    const r = request(app).get(`/api/v1${path}`).set('x-client', 'mobile').set('x-forwarded-for', this.ip);
    if (this.access) r.set('authorization', `Bearer ${this.access}`);
    return r;
  }
  take(res: request.Response) {
    if (res.headers['x-access-token']) this.access = res.headers['x-access-token'];
    if (res.headers['x-refresh-token']) this.refresh = res.headers['x-refresh-token'];
  }
}

async function registerOnPhone(p: Phone, mobile: string) {
  const send = await p.post('/auth/register/send-otp', { name: 'App Advisor', mobile, termsAccepted: true });
  const verify = await p.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(mobile) }, { 'idempotency-key': key() });
  p.take(verify);
  return verify;
}

describe('Mobile app sign-in (same rules, tokens instead of cookies)', () => {
  it('register gives tokens in headers, never cookies or body; the same P-01 result', async () => {
    const p = new Phone();
    const r = await registerOnPhone(p, newMobile());
    expect(r.status).toBe(200);
    expect(r.body.message.code).toBe('AUTH-15');
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(p.access).toBeTruthy();
    expect(p.refresh).toMatch(/^[0-9a-f-]{36}\./);
    expect(JSON.stringify(r.body)).not.toContain(p.refresh!);
    const me = await p.get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.subscription.status).toBe('TRIAL');
  });

  it('an expired access token gets 401; refresh rotates both tokens; the idle rule still applies', async () => {
    const p = new Phone();
    await registerOnPhone(p, newMobile());
    advance(6 * 60_000);
    const expired = await p.get('/auth/me');
    expect(expired.status).toBe(401);
    expect(expired.body.error.reason).toBe('access_expired');
    const old = p.refresh;
    const r = await p.post('/auth/refresh', { refreshToken: p.refresh });
    expect(r.status).toBe(200);
    p.take(r);
    expect(p.refresh).not.toBe(old);
    expect((await p.get('/auth/me')).status).toBe(200);

    // CFG-07: 30 minutes without activity ends the session; refresh does not count as activity
    advance(31 * 60_000);
    const late = await p.post('/auth/refresh', { refreshToken: p.refresh });
    expect(late.status).toBe(401);
    expect(late.body.error.code).toBe('AUTH-18');
  });

  it('a stolen old refresh token ends the session', async () => {
    const p = new Phone();
    await registerOnPhone(p, newMobile());
    const first = p.refresh;
    p.take(await p.post('/auth/refresh', { refreshToken: p.refresh }));
    advance(60_000);
    const thief = await p.post('/auth/refresh', { refreshToken: first });
    expect(thief.status).toBe(401);
    expect((await p.post('/auth/refresh', { refreshToken: p.refresh })).status).toBe(401);
  });

  it('website and phone share the 3-device limit (CFG-09)', async () => {
    const m = newMobile();
    const phone = new Phone();
    await registerOnPhone(phone, m);
    for (let i = 0; i < 3; i++) {
      advance(1000);
      const other = new Phone();
      const s = await other.post('/auth/login/send-otp', { mobile: m });
      await other.post('/auth/login/verify', { challengeId: s.body.challengeId, code: lastCode(m) });
    }
    const r = await phone.get('/auth/me');
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('AUTH-17');
  });

  it('log out with the token ends the session (AUTH-16)', async () => {
    const p = new Phone();
    await registerOnPhone(p, newMobile());
    const r = await p.post('/auth/logout', { refreshToken: p.refresh });
    expect(r.body.message.code).toBe('AUTH-16');
    expect((await p.get('/auth/me')).status).toBe(401);
  });

  it('Check status after a lost sign-in answer gives the tokens again', async () => {
    const m = newMobile();
    const p = new Phone();
    const send = await p.post('/auth/register/send-otp', { name: 'Lost Answer', mobile: m, termsAccepted: true });
    const k = key();
    await p.post('/auth/register/verify', { challengeId: send.body.challengeId, code: lastCode(m) }, { 'idempotency-key': k });
    const status = await new Phone().get(`/requests/${k}`);
    expect(status.body.status).toBe('COMPLETED');
    expect(status.headers['x-access-token']).toBeTruthy();
    expect(status.headers['x-refresh-token']).toBeTruthy();
  });
});
