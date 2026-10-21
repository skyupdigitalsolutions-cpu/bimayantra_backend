import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { auditLog, customers, documentVersions, leads, tasks } from '../src/db/schema.js';
import { addDays, formatDate, istToday } from '../src/lib/clock.js';
import { systemOptOut } from '../src/modules/customers/consent.service.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, SAMPLE, advisor, ensureTypes, insertUser, key, login, newMobile, resetClock, resetSettings, setSetting, upload } from './helpers.js';

beforeAll(async () => {
  await settings.init();
  await ensureTypes();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});
const H = () => ({ 'idempotency-key': key() });
type Adv = Awaited<ReturnType<typeof advisor>>;

async function pipeline(a: Adv) {
  return (await a.d.get('/leads/options')).body.pipelines[0].id as string;
}
async function lead(a: Adv, over: Record<string, unknown> = {}) {
  const r = await a.d.post('/leads', { name: 'Ravi Kumar', mobile: newMobile(), source: 'Walk-in or personal contact', pipelineId: await pipeline(a), ...over }, H());
  return r;
}
async function customer(a: Adv, over: Record<string, unknown> = {}) {
  return a.d.post('/customers', { fullName: 'Meena Rao', mobile: newMobile(), ...over }, H());
}
async function giveConsent(a: Adv, customerId: string, channel: string, familyMemberId?: string, version = 0) {
  return a.d.post(`/customers/${customerId}/consent/record`, { channel, familyMemberId, how: 'Signed form', declaration: true, version });
}

describe('P-12 Create a lead', () => {
  it('AC-P12-1 and AC-P12-5: name, mobile and source save as NEW (LD-01); a double submit creates one lead', async () => {
    const a = await advisor();
    const k = key();
    const body = { name: 'Asha Pai', mobile: newMobile(), source: 'Website', pipelineId: await pipeline(a) };
    const r1 = await a.d.post('/leads', body, { 'idempotency-key': k });
    expect(r1.body.message.text).toMatch(/^Lead LD-\d{4}-00001 created\.$/);
    const r2 = await a.d.post('/leads', body, { 'idempotency-key': k });
    expect((r2.body.lead ?? r2.body.error.result.lead).id).toBe(r1.body.lead.id);
    const rows = await db.select().from(leads).where(eq(leads.accountId, a.accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('NEW');
  });

  it('AC-P12-2/3: an exact duplicate is blocked (LD-02); same mobile, different name warns (LD-03) and can be saved; LD-09', async () => {
    const a = await advisor();
    const mobile = newMobile();
    const first = await lead(a, { name: 'Ravi Kumar', mobile });
    const dup = await lead(a, { name: ' ravi  kumar. ', mobile });
    expect(dup.body.error.fields[0]).toMatchObject({ field: 'mobile', code: 'LD-02' });
    expect(dup.body.error.fields[0].message).toBe(`An open lead with this name and mobile already exists: ${first.body.lead.number}. Open it instead.`);
    const warn = await lead(a, { name: 'Sita Kumar', mobile });
    expect(warn.status).toBe(409);
    expect(warn.body.error.message).toBe(`Another open lead uses this mobile: Ravi Kumar (${first.body.lead.number}). Save anyway if this is a different person.`);
    expect((await lead(a, { name: 'Sita Kumar', mobile, saveAnyway: true })).status).toBe(200);
    const same = await lead(a, { altMobile: mobile, mobile });
    expect(same.body.error.fields.map((f: { code: string }) => f.code)).toContain('LD-09');
    const check = await a.d.get(`/leads/check-duplicate?mobile=${mobile}&name=Ravi%20Kumar`);
    expect(check.body.messages[0].code).toBe('LD-02');
  });

  it('AC-P12-4: Referral source needs a referrer; Campaign needs a name; Referred by a client needs a customer; follow-up in the past (DSH-24)', async () => {
    const a = await advisor();
    const r = await lead(a, { source: 'Referred by a referrer' });
    expect(r.body.error.fields[0]).toMatchObject({ field: 'referrerUserId', message: 'Referrer is required.' });
    expect((await lead(a, { source: 'Campaign' })).body.error.fields[0].message).toBe('Campaign name is required.');
    expect((await lead(a, { source: 'Referred by a client' })).body.error.fields[0].message).toBe('Referred by client is required.');
    expect((await lead(a, { source: 'Referred by a client', referredByCustomerId: 'free text' })).body.error.fields[0].message).toBe('Choose an option from the list.');
    const c = await customer(a);
    expect((await lead(a, { source: 'Referred by a client', referredByCustomerId: c.body.customer.id })).status).toBe(200);
    const ref = await insertUser({ role: 'REF', mobile: newMobile(), accountId: a.accountId });
    expect((await lead(a, { source: 'Referred by a referrer', referrerUserId: ref.id })).status).toBe(200);
    const past = await lead(a, { followUpDate: formatDate(istToday()), followUpTime: '12:00 AM' });
    expect(past.body.error.fields[0].message).toBe('Choose a time later than now.');
    const ok = await lead(a, { followUpDate: formatDate(addDays(istToday(), 1)), followUpTime: '10:30 AM' });
    const [t] = await db.select().from(tasks).where(and(eq(tasks.linkedType, 'LEAD'), eq(tasks.linkedId, ok.body.lead.id)));
    expect(t!.title).toBe('Follow up with Ravi Kumar');
  });

  it('LD-04: a mobile of an ACTIVE customer warns and can still be saved', async () => {
    const a = await advisor();
    const c = await customer(a);
    const r = await lead(a, { mobile: c.body.customer.mobile.slice(3) });
    expect(r.body.error.message).toBe(`Meena Rao is already your customer (${c.body.customer.number}). Open the customer, or save the lead anyway.`);
  });
});

describe('P-13 Work a lead', () => {
  it('AC-P13-1..5: allowed statuses only (GEN-04), LOST needs LD-06, FOLLOW_UP needs a date, Reopen needs a note, timeline in order', async () => {
    const a = await advisor();
    const l = (await lead(a)).body.lead;
    let v = (await a.d.get(`/leads/${l.id}`)).body;
    expect(v.allowedNext).toEqual(['CONTACTED', 'FOLLOW_UP', 'LOST']);
    const bad = await a.d.post(`/leads/${l.id}/status`, { status: 'QUALIFIED', version: v.version });
    expect(bad.body.error.message).toBe('This action is not allowed because this lead is NEW.');
    await a.d.post(`/leads/${l.id}/contact`, { outcome: 'SPOKE', note: 'Interested in health' });
    const c1 = await a.d.post(`/leads/${l.id}/status`, { status: 'CONTACTED', version: v.version });
    expect(c1.body.message.text).toBe('Lead moved to contacted.');
    expect((await a.d.post(`/leads/${l.id}/status`, { status: 'FOLLOW_UP', version: c1.body.version })).body.error.fields[0].message).toBe('Next follow-up is required.');
    const lost = await a.d.post(`/leads/${l.id}/status`, { status: 'LOST', version: c1.body.version });
    expect(lost.body.error.fields[0].message).toBe('Choose a reason for marking this lead as lost.');
    expect((await a.d.post(`/leads/${l.id}/status`, { status: 'LOST', reason: 'Other', version: c1.body.version })).body.error.fields[0].message).toBe('Note is required.');
    const l2 = await a.d.post(`/leads/${l.id}/status`, { status: 'LOST', reason: 'Premium too high', version: c1.body.version });
    expect(l2.body.status).toBe('LOST');
    expect((await a.d.post(`/leads/${l.id}/status`, { status: 'CONTACTED', version: l2.body.version })).body.error.fields[0].message).toBe('Note is required.');
    const re = await a.d.post(`/leads/${l.id}/status`, { status: 'CONTACTED', note: 'Called back', version: l2.body.version });
    expect(re.body.message.text).toBe('Lead reopened.');
    v = (await a.d.get(`/leads/${l.id}`)).body;
    expect(v.timeline.map((e: { text: string }) => e.text)).toEqual(['Lead created', 'Contact: Spoke to customer', 'New → Contacted', 'Contacted → Lost', 'Lost → Contacted']);
    // two tabs: the second gets GEN-05
    expect((await a.d.post(`/leads/${l.id}/status`, { status: 'QUALIFIED', version: l2.body.version })).body.error.code).toBe('GEN-05');
  });

  it('assistants work leads but cannot mark lost or reopen (Section 3.2)', async () => {
    const a = await advisor();
    const m = newMobile();
    await insertUser({ role: 'AST', mobile: m, accountId: a.accountId });
    const ast = new Device();
    await login(ast, m);
    const r = await ast.post('/leads', { name: 'Gopal Rao', mobile: newMobile(), source: 'Website', pipelineId: await pipeline(a) }, H());
    expect(r.status).toBe(200);
    const v = (await ast.get(`/leads/${r.body.lead.id}`)).body;
    expect(v.allowedNext).toEqual(['CONTACTED', 'FOLLOW_UP']);
    expect((await ast.post(`/leads/${r.body.lead.id}/status`, { status: 'LOST', reason: 'Duplicate', version: v.version })).status).toBe(403);
  });
});

describe('P-14 Convert a lead', () => {
  it('AC-P14-1/2/4: one customer, source and referrer copied, follow-up cancelled, converted only once (LD-08)', async () => {
    const a = await advisor();
    const ref = await insertUser({ role: 'REF', mobile: newMobile(), accountId: a.accountId, name: 'Kiran Referrer' });
    const l = (await lead(a, { source: 'Referred by a referrer', referrerUserId: ref.id, followUpDate: formatDate(addDays(istToday(), 2)), followUpTime: '11:00 AM' })).body.lead;
    const full = (await a.d.get(`/leads/${l.id}`)).body;
    const conv = await a.d.post(`/leads/${l.id}/convert`, { fullName: full.name, mobile: full.mobile }, H());
    expect(conv.body.message.text).toBe(`Customer ${conv.body.customer.number} created from lead ${l.number}.`);
    const c = (await a.d.get(`/customers/${conv.body.customer.id}`)).body;
    expect(c).toMatchObject({ source: 'Referred by a referrer', referrerName: 'Kiran Referrer', lead: { number: l.number } });
    const [t] = await db.select().from(tasks).where(eq(tasks.linkedId, l.id));
    expect(t!.status).toBe('CANCELLED');
    const again = await a.d.post(`/leads/${l.id}/convert`, { fullName: full.name, mobile: full.mobile }, H());
    expect(again.body.error.message).toBe(`This lead has been converted. Open customer ${conv.body.customer.number} instead.`);
    expect(await db.select().from(customers).where(eq(customers.accountId, a.accountId))).toHaveLength(1);
  });

  it('AC-P14-3: an exact duplicate links to the existing customer (LD-11)', async () => {
    const a = await advisor();
    const c = (await customer(a, { fullName: 'Ravi Kumar' })).body.customer;
    const l = (await lead(a, { name: 'Ravi Kumar', mobile: c.mobile.slice(3), saveAnyway: true })).body.lead;
    const create = await a.d.post(`/leads/${l.id}/convert`, { fullName: 'Ravi Kumar', mobile: c.mobile }, H());
    expect(create.body.error).toMatchObject({ code: 'CU-02', reason: 'link_only' });
    const link = await a.d.post(`/leads/${l.id}/convert`, { mode: 'LINK', customerId: c.id }, H());
    expect(link.body.message.text).toBe(`Lead ${l.number} linked to existing customer ${c.number}.`);
  });
});

describe('P-15 Customers', () => {
  it('AC-P15-1/2: name and mobile are enough (CU-01); exact duplicates blocked (CU-02); same mobile warns (CU-03)', async () => {
    const a = await advisor();
    const m = newMobile();
    const c = await customer(a, { mobile: m });
    expect(c.body.message.text).toBe('Customer CU-000001 created.');
    expect((await customer(a, { mobile: m })).body.error.fields[0].code).toBe('CU-02');
    const w = await customer(a, { mobile: m, fullName: 'Mohan Rao' });
    expect(w.body.error.message).toBe('Another customer uses this mobile: Meena Rao (CU-000001). Save anyway if this is a different person.');
    expect((await customer(a, { mobile: m, fullName: 'Mohan Rao', saveAnyway: true })).body.customer.number).toBe('CU-000002');
    expect((await customer(a, { anniversary: formatDate(addDays(istToday(), 3)) })).body.error.fields[0].message).toBe('This date cannot be in the future.');
  });

  it('AC-P15-3: another account cannot see the customer or its tabs', async () => {
    const a1 = await advisor();
    const a2 = await advisor();
    const c = (await customer(a1)).body.customer;
    for (const path of ['', '/family', '/consent', '/documents', '/vehicles', '/activity']) expect((await a2.d.get(`/customers/${c.id}${path}`)).status).toBe(404);
  });

  it('AC-P15-4: changing the mobile asks CU-21 and resets WhatsApp and SMS consent', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    await giveConsent(a, c.id, 'WHATSAPP');
    const body = { fullName: c.fullName, mobile: newMobile(), version: c.version };
    const ask = await a.d.post(`/customers/${c.id}`, body);
    expect(ask.body.error.message).toBe('Consent for WhatsApp and SMS belongs to a mobile number. Changing the number removes that consent. Continue?');
    expect((await a.d.post(`/customers/${c.id}`, { ...body, confirmMobileChange: true })).status).toBe(200);
    const grid = (await a.d.get(`/customers/${c.id}/consent`)).body;
    expect(grid.people[0].cells.find((x: { channel: string }) => x.channel === 'WHATSAPP').status).toBe('NOT_RECORDED');
  });

  it('AC-P15-6/7/8: PAN needs personal-data consent (CU-23); stored encrypted, shown masked; reveal is logged; assistants never see it; CU-29', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    const no = await a.d.post(`/customers/${c.id}/identity`, { pan: 'ABCPE1234F', version: c.version });
    expect(no.body.error.message).toBe('Record Meena Rao\'s consent to store personal data before adding PAN or Aadhaar.');
    await giveConsent(a, c.id, 'PERSONAL_DATA');
    const ok = await a.d.post(`/customers/${c.id}/identity`, { pan: 'abcpe1234f', aadhaar: '234567890124', version: c.version });
    expect(ok.status === 200 || ok.body.error.fields?.[0]?.field === 'aadhaar').toBe(true);
    const saved = await a.d.post(`/customers/${c.id}/identity`, { pan: 'ABCPE1234F', version: (await a.d.get(`/customers/${c.id}`)).body.version });
    expect(saved.body.customer.panMasked).toBe('ABCXX1234F');
    const [row] = await db.select().from(customers).where(eq(customers.id, c.id));
    expect(row!.panEnc).not.toContain('ABCPE1234F');
    const rev = await a.d.post(`/customers/${c.id}/reveal`, { field: 'pan' });
    expect(rev.body).toMatchObject({ value: 'ABCPE1234F', seconds: 30 });
    expect(rev.body.message.text).toBe('Showing the full number for 30 seconds. This view is recorded.');
    const logs = await db.select().from(auditLog).where(and(eq(auditLog.entityId, c.id), eq(auditLog.action, 'PERSONAL_DATA_VIEWED')));
    expect(logs).toHaveLength(1);
    const m = newMobile();
    await insertUser({ role: 'AST', mobile: m, accountId: a.accountId });
    const ast = new Device();
    await login(ast, m);
    expect((await ast.post(`/customers/${c.id}/reveal`, { field: 'pan' })).status).toBe(403);
    expect(JSON.stringify((await ast.get(`/customers/${c.id}`)).body)).not.toContain('ABCPE1234F');
    // the same PAN on another customer warns (CU-29)
    const c2 = (await customer(a, { fullName: 'Other Person' })).body.customer;
    await giveConsent(a, c2.id, 'PERSONAL_DATA');
    const w = await a.d.post(`/customers/${c2.id}/identity`, { pan: 'ABCPE1234F', version: (await a.d.get(`/customers/${c2.id}`)).body.version });
    expect(w.body.error.message).toBe('Another customer (CU-000001) has this PAN. Check the number.');
  });

  it('AC-P15-9 links and default nominee: CU-27, CU-26, CU-28; cover map lists every person', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    const s = (await customer(a, { fullName: 'Suresh Rao' })).body.customer;
    const l1 = await a.d.post(`/customers/${c.id}/links`, { linkedCustomerId: s.id, relation: 'Spouse' });
    expect(l1.body.message.text).toBe('Suresh Rao linked as spouse.');
    expect((await a.d.post(`/customers/${s.id}/links`, { linkedCustomerId: c.id, relation: 'Spouse' })).body.error.message).toBe('Meena Rao is already linked as spouse.');
    const n = await a.d.post(`/customers/${c.id}/default-nominee`, { name: 'Suresh Rao', relationship: 'Spouse', sharePercent: '100', version: c.version });
    expect(n.body.message.text).toBe('Default nominee saved. It will be suggested on new proposals.');
    const map = (await a.d.get(`/customers/${c.id}/cover-map`)).body;
    expect(map.people.map((p: { name: string }) => p.name)).toEqual(['Meena Rao', 'Suresh Rao']);
  });
});

describe('P-16 Family, P-17 Consent', () => {
  it('AC-P16-1/4: CU-05, CU-07 duplicate, CFG-35 limit (CU-06), CU-19 deactivate', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    await setSetting('CFG-35', 1);
    const m = await a.d.post(`/customers/${c.id}/family`, { fullName: 'Anu Rao', relationship: 'Daughter' });
    expect(m.body.message.text).toBe("Anu Rao added to Meena Rao's family.");
    expect((await a.d.post(`/customers/${c.id}/family`, { fullName: 'Ravi Rao', relationship: 'Son' })).body.error.message).toBe('A customer can have up to 1 family members.');
    await setSetting('CFG-35', 15);
    expect((await a.d.post(`/customers/${c.id}/family`, { fullName: 'anu rao', relationship: 'Daughter' })).body.error.fields[0].message).toBe('Anu Rao (daughter) is already in this family.');
    const d = await a.d.post(`/customers/${c.id}/family/${m.body.member.id}/deactivate`, { version: m.body.member.version });
    expect(d.body.message.text).toBe('Anu Rao is now inactive. Greetings for them have stopped.');
  });

  it('AC-P17-1/3/4: no consent without a mobile (CU-13) or email (CU-14); CU-11, CU-12; STOP sets WITHDRAWN; history', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    const m = (await a.d.post(`/customers/${c.id}/family`, { fullName: 'Anu Rao', relationship: 'Daughter' })).body.member;
    expect((await giveConsent(a, c.id, 'WHATSAPP', m.id)).body.error.message).toBe('Add a mobile number for Anu Rao before recording WhatsApp consent.');
    expect((await giveConsent(a, c.id, 'EMAIL')).body.error.message).toBe('Add an email address for Meena Rao before recording email consent.');
    const noTick = await a.d.post(`/customers/${c.id}/consent/record`, { channel: 'SMS', how: 'Signed form', version: 0 });
    expect(noTick.body.error.fields[0].message).toBe('Tick this box to continue.');
    const g = await giveConsent(a, c.id, 'SMS');
    expect(g.body.message.text).toBe('SMS consent recorded for Meena Rao.');
    const w = await a.d.post(`/customers/${c.id}/consent/withdraw`, { channel: 'SMS', version: 1 });
    expect(w.body.message.text).toBe('SMS consent withdrawn for Meena Rao. No more automated SMS messages will be sent.');
    await giveConsent(a, c.id, 'WHATSAPP');
    expect(await systemOptOut(a.accountId, 'WHATSAPP', c.mobile)).toBe(1);
    const grid = (await a.d.get(`/customers/${c.id}/consent`)).body;
    expect(grid.people[0].cells.find((x: { channel: string }) => x.channel === 'WHATSAPP').status).toBe('WITHDRAWN');
    const h = (await a.d.get(`/customers/${c.id}/consent/history`)).body.items;
    expect(h[0]).toMatchObject({ channel: 'WHATSAPP', to: 'WITHDRAWN', how: 'STOP reply', by: 'System (opt-out)' });
    expect(h.length).toBe(4);
  });
});

describe('P-18 Documents', () => {
  it('AC-P18-1..5: DOC-01/02 before upload; identity needs consent; versions kept; nothing saved before Confirm; label rules; no delete', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    const file = async () => (await upload(a.d, 'CLIENT_DOCUMENT', [{ name: 'doc.pdf', data: SAMPLE.pdf }])).body.items[0].id as string;
    expect((await a.d.post('/documents', { fileId: await file() }, H())).body.error.message).toBe('Choose the customer, person and document type first.');
    expect((await a.d.post('/documents', { customerId: c.id, type: 'Other', fileId: await file() }, H())).body.error.fields[0].message).toBe('Enter a name for this document.');
    expect((await a.d.post('/documents', { customerId: c.id, type: 'PAN', fileId: await file() }, H())).body.error.code).toBe('CU-23');
    const r1 = await a.d.post('/documents', { customerId: c.id, type: 'Address proof', fileId: await file() }, H());
    expect(r1.body.message.text).toBe('Address proof saved as version 1.');
    const r2 = await a.d.post('/documents', { customerId: c.id, type: 'Address proof', fileId: await file() }, H());
    expect(r2.body.message.text).toBe('Address proof saved as version 2.');
    await giveConsent(a, c.id, 'PERSONAL_DATA');
    const pan = await a.d.post('/documents', { customerId: c.id, type: 'PAN', fileId: await file() }, H());
    expect(pan.body.verify.prompt.text).toBe('Check the details read from the document and correct anything wrong, then select Confirm.');
    let list = (await a.d.get(`/customers/${c.id}/documents`)).body;
    expect(list.missing.text).toBe('Missing for Meena Rao: Aadhaar, PAN (waiting to be checked).');
    expect((await db.select().from(customers).where(eq(customers.id, c.id)))[0]!.panEnc).toBeNull();
    const conf = await a.d.post(`/documents/versions/${pan.body.version.id}/confirm`, { values: { name: 'Meena Rao', pan: 'ABCPE1234F' }, version: 1 }, H());
    expect(conf.body.status).toBe('CONFIRMED');
    expect((await a.d.get(`/customers/${c.id}`)).body.panMasked).toBe('ABCXX1234F');
    const [v] = await db.select().from(documentVersions).where(eq(documentVersions.id, pan.body.version.id));
    expect(JSON.stringify(v!.confirmedValues)).not.toContain('ABCPE1234F');
    list = (await a.d.get(`/customers/${c.id}/documents`)).body;
    const addr = list.items.find((d: { type: string }) => d.type === 'Address proof');
    expect(addr.versions.map((x: { versionNo: number }) => x.versionNo)).toEqual([2, 1]);
    expect((await a.d.post(`/documents/${addr.id}/label`, { label: '', version: addr.version })).body.error.fields[0].code).toBe('GEN-01');
    const panDoc = list.items.find((d: { type: string }) => d.type === 'PAN');
    expect((await a.d.post(`/documents/${addr.id}/label`, { label: panDoc.label, version: addr.version })).body.error.fields[0].message).toBe('Another document of this customer already has this label.');
    const lab = await a.d.post(`/documents/${addr.id}/label`, { label: 'Electricity bill', version: addr.version });
    expect(lab.body.message.text).toBe('Label changed. The original upload name is kept in the history.');
    list = (await a.d.get(`/customers/${c.id}/documents`)).body;
    expect(list.items.find((d: { id: string }) => d.id === addr.id).labelHistory[0].text).toBe('Uploaded as doc.pdf');
    const del = await a.d.agent.delete(`/api/v1/documents/${addr.id}`).set('x-forwarded-for', a.d.ip);
    expect(del.body.error.message).toBe('Documents cannot be deleted. You can change the label or upload a newer version.');
  });

  it('AC-P18-7: another account cannot open the document file', async () => {
    const a1 = await advisor();
    const a2 = await advisor();
    const f = (await upload(a1.d, 'CLIENT_DOCUMENT', [{ name: 'x.pdf', data: SAMPLE.pdf }])).body.items[0].id;
    expect((await a2.d.get(`/files/${f}/link`)).status).toBe(404);
  });
});

describe('P-54 Vehicles, P-19 Deactivate, P-08/P-09', () => {
  it('AC-P54-1..4: VEH-02 too few photos, VEH-01, VEH-03 duplicate, sold keeps photos', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    const photo = async () => (await upload(a.d, 'VEHICLE_PHOTO', [{ name: 'p.png', data: SAMPLE.png }])).body.items[0].id as string;
    const rc = (await upload(a.d, 'CLIENT_DOCUMENT', [{ name: 'rc.pdf', data: SAMPLE.pdf }])).body.items[0].id as string;
    const base = { registration: 'ka 01 ab 1234', vehicleType: 'PRIVATE_CAR', make: 'Maruti', model: 'Swift', year: 2021, fuel: 'PETROL', rcFileId: rc };
    const few = await a.d.post(`/customers/${c.id}/vehicles`, { ...base, photos: [{ slot: 'Front', fileId: await photo() }] }, H());
    expect(few.body.error.fields[0].message).toBe('Add at least 4 photos before saving.');
    const photos = [];
    for (const slot of ['Front', 'Rear', 'Left', 'Right']) photos.push({ slot, fileId: await photo() });
    const ok = await a.d.post(`/customers/${c.id}/vehicles`, { ...base, photos }, H());
    expect(ok.body.message.text).toBe('Vehicle KA01AB1234 added for Meena Rao.');
    expect((await a.d.post(`/customers/${c.id}/vehicles`, { ...base, photos }, H())).body.error.fields[0].message).toBe('Vehicle KA01AB1234 is already recorded for Meena Rao.');
    const list = (await a.d.get(`/customers/${c.id}/vehicles`)).body;
    const v = list.items[0];
    expect(v.photos).toHaveLength(4);
    const sold = await a.d.post(`/customers/${c.id}/vehicles/${v.id}/sold`, { version: v.version });
    expect(sold.status).toBe(200);
    expect((await a.d.get(`/customers/${c.id}/vehicles`)).body.items[0]).toMatchObject({ status: 'INACTIVE', rc: expect.anything() });
  });

  it('AC-P19-3: deactivate needs a reason; CU-09; edits refused (CU-20); reactivate CU-10', async () => {
    const a = await advisor();
    const c = (await customer(a)).body.customer;
    expect((await a.d.post(`/customers/${c.id}/deactivate`, { version: c.version })).body.error.fields[0].code).toBe('GEN-01');
    const d = await a.d.post(`/customers/${c.id}/deactivate`, { reason: 'Not reachable', version: c.version });
    expect(d.body.message.text).toBe('Meena Rao is now inactive. Automated messages to this customer and family have stopped.');
    expect((await a.d.post(`/customers/${c.id}`, { fullName: 'Meena Rao', mobile: c.mobile, version: d.body.customer.version })).body.error.message).toBe('Meena Rao is inactive. Reactivate the customer to do this.');
    expect((await a.d.get(`/customers/${c.id}`)).status).toBe(200); // history stays visible
    const r = await a.d.post(`/customers/${c.id}/reactivate`, { version: d.body.customer.version });
    expect(r.body.message.text).toBe('Meena Rao is active again.');
  });

  it('AC-P08-1/2 counts and funnel; AC-P09-1/2/3 search', async () => {
    const a = await advisor();
    const other = await advisor();
    await lead(a);
    const l = (await lead(a, { name: 'Lost Lead' })).body.lead;
    const lv = (await a.d.get(`/leads/${l.id}`)).body;
    await a.d.post(`/leads/${l.id}/status`, { status: 'LOST', reason: 'Duplicate', version: lv.version });
    const c = (await customer(a, { fullName: 'Lakshmi Narayan' })).body.customer;
    await customer(other, { fullName: 'Lakshmi Other' });
    const counts = (await a.d.get('/dashboard/counts')).body.items;
    expect(counts.find((x: { key: string }) => x.key === 'openLeads').value).toBe(1);
    expect(counts.find((x: { key: string }) => x.key === 'activeCustomers').value).toBe(1);
    const f = (await a.d.get('/dashboard/funnel?period=month')).body;
    expect(f.total).toBe(2);
    expect(f.bars.find((b: { status: string }) => b.status === 'LOST').count).toBe(1);
    expect((await a.d.get('/dashboard/search?q=la')).body.message.text).toBe('Type at least 3 characters to search.');
    const s = (await a.d.get('/dashboard/search?q=lakshmi')).body;
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].items.map((i: { title: string }) => i.title)).toEqual(['Lakshmi Narayan']);
    const byDigits = (await a.d.get(`/dashboard/search?q=${c.mobile.slice(-4)}`)).body;
    expect(byDigits.groups.flatMap((g: { items: { id: string }[] }) => g.items.map((i) => i.id))).toContain(c.id);
    expect((await a.d.get('/dashboard/search?q=zzzzqq')).body.message.text).toBe('No matches for "zzzzqq".');
  });
});
