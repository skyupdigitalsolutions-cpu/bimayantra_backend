import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { advisorKyc, advisorProfiles, insurerMappings, notifications } from '../src/db/schema.js';
import { addDays, formatDate, istToday } from '../src/lib/clock.js';
import { sharingBlock } from '../src/modules/profile/profile.service.js';
import { sentEmails } from '../src/modules/email/email.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, SAMPLE, advance, advisor, createInsurer, ensureTypes, insertUser, key, login, newMobile, resetClock, resetSettings, setSetting, upload } from './helpers.js';

beforeAll(async () => {
  await settings.init();
  await ensureTypes();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

const profile = (d: Device) => d.get('/profile');
const save = (d: Device, section: string, body: object) => d.post(`/profile/sections/${section}`, body);

async function fullProfile(d: Device) {
  const p = (await profile(d)).body;
  const types = p.insuranceTypes as { id: string }[];
  await save(d, 'personal', { fullName: 'Asha Rao', dateOfBirth: '15-08-1990', gender: 'FEMALE', version: p.personal.version });
  await save(d, 'contact', { email: 'asha@example.com', addressLine1: '12, MG Road', city: 'Bengaluru', state: 'Karnataka', pinCode: '560001', version: p.contact.version });
  await save(d, 'professional', { advisorType: 'POSP', licenceNumber: 'POSP-123', licenceValidUntil: formatDate(addDays(istToday(), 400)), authorisedTypeIds: [types[0]!.id], version: p.professional.version });
  return save(d, 'business', { businessName: 'Asha Insurance Services', version: p.business.version });
}

async function submitKyc(d: Device, version: number, pan = 'ABCPE1234F') {
  const a = await upload(d, 'KYC_PAN', [{ name: 'pan.png', data: SAMPLE.png }]);
  const b = await upload(d, 'KYC_LICENCE', [{ name: 'licence.pdf', data: SAMPLE.pdf }]);
  return d.post('/kyc', { pan, nameOnPan: 'Asha Rao', panFileId: a.body.items[0].id, licenceFileId: b.body.items[0].id, declaration: true, version }, { 'idempotency-key': key() });
}

describe('P-05 Complete the advisor profile', () => {
  it('AC-P05-1 / AC-P05-3: saving one section keeps the others and returns the new %; a failed save changes nothing', async () => {
    const { d } = await advisor('Asha Rao');
    const before = (await profile(d)).body;
    expect(before.completion.percent).toBe(7); // name from registration: half of Personal (15)
    expect(before.completion.message.code).toBe('PRF-02');
    const r = await save(d, 'contact', { email: 'asha@example.com', addressLine1: '12, MG Road', city: 'Bengaluru', state: 'Karnataka', pinCode: '560001', version: before.contact.version });
    expect(r.status).toBe(200);
    expect(r.body.message).toEqual({ code: 'PRF-01', text: 'Profile saved. Your profile is 27% complete.' });
    const after = (await profile(d)).body;
    expect(after.personal).toEqual(before.personal);
    expect(after.contact.city).toBe('Bengaluru');

    const bad = await save(d, 'contact', { email: 'not-an-email', pinCode: '012345', version: after.contact.version });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('GEN-02');
    expect((await profile(d)).body.completion.percent).toBe(27);
  });

  it('AC-P05-2: missing optional fields never block the dashboard', async () => {
    const { d } = await advisor();
    expect((await d.get('/dashboard/profile')).status).toBe(200);
    expect((await d.get('/dashboard/tasks')).status).toBe(200);
  });

  it('AC-P05-6: two tabs saving the same section — the second gets GEN-05 with the changed fields', async () => {
    const { d } = await advisor();
    const v = (await profile(d)).body.contact.version;
    expect((await save(d, 'contact', { city: 'Mysuru', version: v })).status).toBe(200);
    const second = await save(d, 'contact', { city: 'Tumakuru', version: v });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('GEN-05');
    expect(second.body.error.changedFields).toContain('city');
  });

  it('PRF-14 under-age advisor; future date of birth VAL-05; past licence date VAL-07; inactive type VAL-22', async () => {
    const { d } = await advisor();
    const p = (await profile(d)).body;
    const young = formatDate(addDays(istToday(), -365 * 17));
    const r = await save(d, 'personal', { fullName: 'Young One', dateOfBirth: young, version: p.personal.version });
    expect(r.body.error.code).toBe('PRF-14');
    expect(r.body.error.message).toBe('You must be 18 or older to use Bimayantra as an advisor.');
    expect((await save(d, 'personal', { fullName: 'X Y', dateOfBirth: formatDate(addDays(istToday(), 1)), version: p.personal.version })).body.error.code).toBe('VAL-05');
    expect((await save(d, 'professional', { licenceValidUntil: formatDate(addDays(istToday(), -1)), version: p.professional.version })).body.error.code).toBe('VAL-07');
    expect((await save(d, 'professional', { authorisedTypeIds: ['00000000-0000-4000-8000-000000000000'], version: p.professional.version })).body.error.code).toBe('VAL-22');
    expect((await save(d, 'contact', { altMobile: (await d.get('/auth/me')).body.user.mobile, version: p.contact.version })).body.error.code).toBe('AUTH-24');
  });

  it('a complete profile reaches 100%; milestones (CFG-129) notify once each', async () => {
    const { d, accountId } = await advisor('Asha Rao');
    await fullProfile(d);
    const p1 = (await profile(d)).body;
    expect(p1.completion.percent).toBe(65); // all sections except KYC (20) and Insurers (15)
    await submitKyc(d, 1);
    const ins = await createInsurer('Milestone General');
    await d.post('/insurers/mine', { insurerId: ins.id, agentCode: 'AG-1', declaration: true }, { 'idempotency-key': key() });
    const p2 = (await profile(d)).body;
    expect(p2.completion.percent).toBe(100);
    expect(p2.completion.message).toBeNull();
    const ms = await db.select().from(notifications).where(and(eq(notifications.accountId, accountId), eq(notifications.messageId, 'DSH-10')));
    expect(ms.map((n) => n.text).sort()).toEqual(['Your profile is 100% complete.', 'Your profile is 50% complete.']);
    expect((await d.get('/dashboard/profile')).body.card).toBeNull(); // hidden at 100%
    // Saving again does not notify again
    await save(d, 'business', { businessName: 'Asha Insurance', version: (await profile(d)).body.business.version });
    expect((await db.select().from(notifications).where(and(eq(notifications.accountId, accountId), eq(notifications.messageId, 'DSH-10')))).length).toBe(2);
  });

  it('changing the weights (CFG-124) recalculates the % on the next view', async () => {
    const { d } = await advisor();
    await setSetting('CFG-124', { personal: 50, contact: 10, professional: 10, business: 10, kyc: 10, insurers: 10 });
    expect((await profile(d)).body.completion.percent).toBe(25);
  });

  it('AC-P05-4 / AC-P05-5 / AC-P06-5: sharing lists exactly what is missing; a passed licence date gives PRF-13', async () => {
    const { d, accountId } = await advisor();
    expect((await sharingBlock(accountId))?.params['missing items']).toBe('Email, IRDAI licence or POSP certificate number');
    await fullProfile(d);
    expect(await sharingBlock(accountId)).toBeNull();
    await setSetting('CFG-100', true);
    expect((await sharingBlock(accountId))?.params['missing items']).toBe('Verified KYC');
    await db.update(advisorProfiles).set({ licenceValidUntil: addDays(istToday(), -1) }).where(eq(advisorProfiles.accountId, accountId));
    expect((await sharingBlock(accountId))?.code).toBe('PRF-13');
    expect((await profile(d)).body.licence.message.code).toBe('PRF-17');
  });

  it('licence expiry warning PRF-16 from CFG-152 days before', async () => {
    const { d, accountId } = await advisor();
    await db.update(advisorProfiles).set({ licenceValidUntil: addDays(istToday(), 30) }).where(eq(advisorProfiles.accountId, accountId));
    expect((await profile(d)).body.licence.message.code).toBe('PRF-16');
  });

  it('an assistant can view the profile but not change it (GEN-03)', async () => {
    const { accountId } = await advisor();
    const m = newMobile();
    await insertUser({ role: 'AST', mobile: m, accountId });
    const ast = new Device();
    await login(ast, m);
    expect((await ast.get('/profile')).status).toBe(200);
    const r = await save(ast, 'contact', { city: 'Mysuru', version: 1 });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('GEN-03');
  });
});

describe('Files (FLD-22, GR-32)', () => {
  it('checks type by content, size, count and password protection', async () => {
    const { d } = await advisor();
    expect((await upload(d, 'KYC_PAN', [{ name: 'evil.png', data: SAMPLE.exe }])).body.error.code).toBe('VAL-23');
    expect((await upload(d, 'PROFILE_PHOTO', [{ name: 'a.pdf', data: SAMPLE.pdf }])).body.error.message).toBe('This file type is not allowed. Upload one of: JPG, PNG.');
    expect((await upload(d, 'KYC_LICENCE', [{ name: 'locked.pdf', data: SAMPLE.lockedPdf }])).body.error.code).toBe('VAL-26');
    const big = Buffer.concat([SAMPLE.png.subarray(0, 8), Buffer.alloc(3 * 1024 * 1024), Buffer.from('IEND'), Buffer.alloc(4)]);
    const r = await upload(d, 'PROFILE_PHOTO', [{ name: 'big.png', data: big }]);
    expect(r.body.error.message).toBe('This file is larger than 2 MB. Upload a smaller file.');
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.pdf`, data: SAMPLE.pdf }));
    expect((await upload(d, 'APPOINTMENT_LETTER', six)).body.error.code).toBe('VAL-25');
    const ok = await upload(d, 'PROFILE_PHOTO', [{ name: 'me.jpg', data: SAMPLE.jpg }]);
    expect(ok.status).toBe(200);
    expect(ok.body.items[0].mime).toBe('image/jpeg');
  });

  it('an upload without the custom header is refused (no cross-site form posts)', async () => {
    const { d } = await advisor();
    const r = await d.agent.post('/api/v1/files').set('x-forwarded-for', d.ip).field('purpose', 'PROFILE_PHOTO').attach('files', SAMPLE.png, 'a.png');
    expect(r.status).toBe(403);
  });

  it('download links expire after CFG-31 and work only for the user they were made for', async () => {
    const { d } = await advisor();
    const f = (await upload(d, 'PROFILE_PHOTO', [{ name: 'me.png', data: SAMPLE.png }])).body.items[0];
    const link = (await d.get(`/files/${f.id}/link`)).body;
    const got = await d.agent.get(link.url).set('x-forwarded-for', d.ip);
    expect(got.status).toBe(200);
    expect(Buffer.compare(got.body as Buffer, SAMPLE.png)).toBe(0);
    const other = await advisor();
    expect((await other.d.agent.get(link.url).set('x-forwarded-for', other.d.ip)).status).toBe(404);
    expect((await other.d.get(`/files/${f.id}/link`)).body.error.code).toBe('GEN-11');
    // The phone's PDF viewer opens the link without the sign-in header: allowed while that session is active
    const request = (await import('supertest')).default;
    const { app } = await import('./helpers.js');
    expect((await request(app).get(link.url)).status).toBe(200);
    advance(11 * 60_000);
    await d.post('/auth/keep-alive');
    expect((await d.agent.get(link.url).set('x-forwarded-for', d.ip)).status).toBe(404);
    const fresh = (await d.get(`/files/${f.id}/link`)).body;
    await d.post('/auth/logout');
    expect((await request(app).get(fresh.url)).status).toBe(404); // session ended → link is dead
  });
});

describe('P-06 Submit and review KYC', () => {
  it('AC-P06-1 / AC-P06-2: submit → PENDING_REVIEW and in the queue; reject needs a reason; verify notifies by bell and email', async () => {
    const { d, accountId } = await advisor('Kyc Person');
    const p = (await profile(d)).body;
    await save(d, 'contact', { email: 'kyc@example.com', version: p.contact.version });
    const k = (await d.get('/kyc')).body;
    expect(k.status).toBe('NOT_SUBMITTED');
    const missing = await d.post('/kyc', { version: k.version }, { 'idempotency-key': key() });
    expect(missing.body.error.code).toBe('GEN-02');
    const r = await submitKyc(d, k.version);
    expect(r.status).toBe(200);
    expect(r.body.message.text).toBe('KYC submitted for review. We aim to review it within 2 working days.');
    const [row] = await db.select().from(advisorKyc).where(eq(advisorKyc.accountId, accountId));
    expect(row!.panEnc).not.toContain('ABCPE1234F'); // encrypted (GR-36)

    const stfMobile = newMobile();
    await insertUser({ role: 'STF', mobile: stfMobile });
    const stf = new Device();
    await login(stf, stfMobile);
    const queue = (await stf.get('/admin/kyc')).body.items;
    expect(queue.some((q: { accountId: string }) => q.accountId === accountId)).toBe(true);
    const item = (await stf.get(`/admin/kyc/${accountId}`)).body;
    expect(item.pan).toBe('ABCPE1234F');
    const noReason = await stf.post(`/admin/kyc/${accountId}/decision`, { decision: 'REJECT', version: item.version });
    expect(noReason.body.error.message).toBe('Reason is required.');
    const rej = await stf.post(`/admin/kyc/${accountId}/decision`, { decision: 'REJECT', reason: 'DOCUMENT_UNCLEAR', version: item.version });
    expect(rej.body.status).toBe('REJECTED');
    const bell = await db.select().from(notifications).where(and(eq(notifications.accountId, accountId), eq(notifications.messageId, 'PRF-06')));
    expect(bell[0]!.text).toBe('Your KYC was not accepted: Document unclear. Please correct it and submit again.');
    expect(sentEmails.some((e) => e.to === 'kyc@example.com' && e.text.startsWith('Your KYC was not accepted'))).toBe(true);

    const again = await submitKyc(d, (await d.get('/kyc')).body.version);
    expect(again.body.status).toBe('PENDING_REVIEW');
    const v2 = (await stf.get(`/admin/kyc/${accountId}`)).body.version;
    expect((await stf.post(`/admin/kyc/${accountId}/decision`, { decision: 'VERIFY', version: v2 })).body.status).toBe('VERIFIED');
    // A second reviewer acting on the same item gets GEN-04
    const late = await stf.post(`/admin/kyc/${accountId}/decision`, { decision: 'REJECT', reason: 'PAN_INVALID', version: v2 });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('GEN-04');
    expect(sentEmails.some((e) => e.to === 'kyc@example.com' && e.text === 'Your KYC has been verified.')).toBe(true);
  });

  it('AC-P06-3: changing verified KYC returns it to PENDING_REVIEW', async () => {
    const { d, accountId } = await advisor();
    await submitKyc(d, 1);
    await db.update(advisorKyc).set({ status: 'VERIFIED' }).where(eq(advisorKyc.accountId, accountId));
    const r = await submitKyc(d, 2, 'ABCPE9999F');
    expect(r.body.status).toBe('PENDING_REVIEW');
  });

  it('AC-P06-4: another advisor cannot open the KYC files (GEN-11); assistants see a masked PAN only', async () => {
    const { d, accountId } = await advisor();
    await submitKyc(d, 1);
    const k = (await d.get('/kyc')).body;
    const other = await advisor();
    expect((await other.d.get(`/files/${k.panFileId}/link`)).body.error.code).toBe('GEN-11');
    const m = newMobile();
    await insertUser({ role: 'AST', mobile: m, accountId });
    const ast = new Device();
    await login(ast, m);
    const view = (await ast.get('/kyc')).body;
    expect(view.panMasked).toBe('ABCXX1234F');
    expect(JSON.stringify(view)).not.toContain('ABCPE1234F');
    expect((await ast.get(`/files/${k.panFileId}/link`)).status).toBe(404);
    expect((await upload(ast, 'KYC_PAN', [{ name: 'p.png', data: SAMPLE.png }])).status).toBe(403);
  });
});

describe('P-07 Add insurers and agent codes', () => {
  it('AC-P07-1 / AC-P07-2: many insurers, each with its own code; the same insurer twice → PRF-09', async () => {
    const { d } = await advisor();
    const a = await createInsurer('Alpha General');
    const b = await createInsurer('Beta Health');
    const r1 = await d.post('/insurers/mine', { insurerId: a.id, agentCode: 'ag-001', declaration: true }, { 'idempotency-key': key() });
    expect(r1.body.message.text).toBe('Alpha General added with agent code AG-001.');
    await d.post('/insurers/mine', { insurerId: b.id, agentCode: 'BH/77', declaration: true }, { 'idempotency-key': key() });
    const list = (await d.get('/insurers/mine')).body.items;
    expect(list.map((x: { agentCode: string }) => x.agentCode).sort()).toEqual(['AG-001', 'BH/77']);
    const dup = await d.post('/insurers/mine', { insurerId: a.id, agentCode: 'X1', declaration: true }, { 'idempotency-key': key() });
    expect(dup.body.error.message).toBe('You have already added Alpha General. Edit the existing entry instead.');
    const avail = (await d.get('/insurers/available')).body.items.map((x: { id: string }) => x.id);
    expect(avail).not.toContain(a.id);
  });

  it('AC-P07-3: an INACTIVE insurer cannot be added', async () => {
    const { d } = await advisor();
    const x = await createInsurer('Gone Insurance', 'INACTIVE');
    const r = await d.post('/insurers/mine', { insurerId: x.id, agentCode: 'A1', declaration: true }, { 'idempotency-key': key() });
    expect(r.body.error.code).toBe('VAL-22');
  });

  it('AC-P07-4 / AC-P07-5: deactivating keeps the entry; a passed code date shows PRF-11; a catalogue removal shows PRF-10', async () => {
    const { d, accountId } = await advisor();
    const a = await createInsurer('Gamma Life');
    await d.post('/insurers/mine', { insurerId: a.id, agentCode: 'GL-1', declaration: true }, { 'idempotency-key': key() });
    let e = (await d.get('/insurers/mine')).body.items[0];
    const off = await d.post(`/insurers/mine/${e.id}/deactivate`, { version: e.version });
    expect(off.body.status).toBe('INACTIVE');
    e = (await d.get('/insurers/mine')).body.items[0];
    expect(e.status).toBe('INACTIVE');
    expect((await d.post(`/insurers/mine/${e.id}/deactivate`, { version: e.version })).body.error.code).toBe('GEN-04');
    await d.post(`/insurers/mine/${e.id}/activate`, { version: e.version });
    await db.update(insurerMappings).set({ codeValidUntil: addDays(istToday(), -2) }).where(eq(insurerMappings.accountId, accountId));
    e = (await d.get('/insurers/mine')).body.items[0];
    expect(e.warning.code).toBe('PRF-11');
    const { insurers } = await import('../src/db/schema.js');
    await db.update(insurers).set({ status: 'INACTIVE' }).where(eq(insurers.id, a.id));
    expect((await d.get('/insurers/mine')).body.items[0].warning.code).toBe('PRF-10');
  });

  it('the same insurer and agent code in two accounts is flagged for SkyUp review without telling either advisor', async () => {
    const a = await createInsurer('Delta General');
    const one = await advisor();
    const two = await advisor();
    const r1 = await one.d.post('/insurers/mine', { insurerId: a.id, agentCode: 'SAME-1', declaration: true }, { 'idempotency-key': key() });
    const r2 = await two.d.post('/insurers/mine', { insurerId: a.id, agentCode: 'SAME-1', declaration: true }, { 'idempotency-key': key() });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(JSON.stringify(r2.body)).not.toMatch(/flag|review/i);
    const rows = await db.select().from(insurerMappings).where(eq(insurerMappings.insurerId, a.id));
    expect(rows.every((r) => r.flaggedForReview)).toBe(true);
  });
});
