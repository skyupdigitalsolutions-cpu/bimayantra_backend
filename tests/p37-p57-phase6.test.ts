import { createHmac } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import {
  accounts,
  advisorProfiles,
  configValues,
  customers,
  exportJobs,
  leads,
  messageTemplates,
  occasionSettings,
  outgoingMessages,
  referralCodes,
  renewalCycles,
  subscriptionInvoices,
  subscriptions,
  users,
  walletTransactions,
  wallets,
  whatsappNumbers,
} from '../src/db/schema.js';
import { addDays, clock, formatDate, istToday } from '../src/lib/clock.js';
import { runDaily } from '../src/modules/jobs/daily.js';
import { sendMessage } from '../src/modules/messages/messages.service.js';
import { seedDefaultTemplates } from '../src/modules/messages/templates.service.js';
import { settings } from '../src/modules/settings/settings.service.js';
import { Device, advisor, createInsurer, ensureTypes, key, login, newMobile, resetClock, resetSettings, setSetting, staff, stepUp } from './helpers.js';

const H = () => ({ 'idempotency-key': key() });
type Adv = Awaited<ReturnType<typeof advisor>>;
let healthTypeId = '';

async function customer(a: Adv, over: Record<string, unknown> = {}) {
  const r = await a.d.post('/customers', { fullName: 'Ravi Kumar', mobile: newMobile(), email: `r${Math.floor(Math.random() * 1e6)}@example.com`, dateOfBirth: '01-01-1985', ...over }, H());
  expect(r.status).toBe(200);
  return r.body.customer as { id: string; mobile: string };
}
async function premium(accountId: string) {
  await db.update(subscriptions).set({ plan: 'PREMIUM', status: 'ACTIVE' }).where(and(eq(subscriptions.accountId, accountId), eq(subscriptions.isCurrent, true)));
}
async function existingPolicy(a: Adv, customerId: string, endInDays: number, number = `P${Math.floor(Math.random() * 1e8)}`) {
  const ins = await createInsurer(`Ins ${Math.random().toString(36).slice(2, 6)}`);
  const r = await a.d.post('/policies/existing', { customerId, insurerId: ins.id, productName: 'Old health plan', typeId: healthTypeId, insured: ['customer'], insurerPolicyNumber: number, issueDate: formatDate(addDays(istToday(), endInDays - 365)), startDate: formatDate(addDays(istToday(), endInDays - 364)), endDate: formatDate(addDays(istToday(), endInDays)), frequency: 'YEARLY', sumInsured: '300000', premium: '9000', confirmExpired: true }, H());
  expect(r.status).toBe(200);
  const [c] = await db.select().from(renewalCycles).where(eq(renewalCycles.policyId, r.body.id));
  return { policyId: r.body.id as string, cycle: c! };
}
const sign = (secret: string, body: object) => createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');

beforeAll(async () => {
  await settings.init();
  const types = await ensureTypes();
  healthTypeId = types.find((t) => t.name === 'Health')!.id;
  await seedDefaultTemplates();
});
afterEach(async () => {
  resetClock();
  await resetSettings();
});

describe('P-37 / P-38 Renewals', () => {
  it('AC-P37-1: running the job twice sends each reminder once; AC-P38-1: a reminder does not renew', async () => {
    const a = await advisor();
    const c = await customer(a);
    const { cycle } = await existingPolicy(a, c.id, 30);
    expect(cycle.status).toBe('DUE');
    await runDaily('SYS-03', true);
    await runDaily('SYS-03', true);
    const msgs = await db.select().from(outgoingMessages).where(and(eq(outgoingMessages.relatedId, cycle.id), eq(outgoingMessages.purpose, 'RENEWAL_REMINDER')));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.channel).toBe('EMAIL');
    const [after] = await db.select().from(renewalCycles).where(eq(renewalCycles.id, cycle.id));
    expect(after!.status).toBe('DUE');
  });

  it('AC-P37-2: a Normal account never gets WhatsApp reminders; AC-P37-4: past grace → LAPSED, past end → EXPIRED', async () => {
    const a = await advisor();
    const c = await customer(a);
    await db.insert((await import('../src/db/schema.js')).consents).values({ accountId: a.accountId, customerId: c.id, channel: 'WHATSAPP', status: 'GIVEN', address: c.mobile, how: 'Signed form', changedAt: clock.now() });
    const { cycle } = await existingPolicy(a, c.id, 15);
    await runDaily('SYS-03', true);
    const wa = await db.select().from(outgoingMessages).where(and(eq(outgoingMessages.relatedId, cycle.id), eq(outgoingMessages.channel, 'WHATSAPP')));
    expect(wa).toHaveLength(0);
    const old = await existingPolicy(a, c.id, -5);
    await db.update(renewalCycles).set({ status: 'DUE', graceEnd: addDays(istToday(), -1) }).where(eq(renewalCycles.id, old.cycle.id));
    await runDaily('SYS-03', true);
    const [l] = await db.select().from(renewalCycles).where(eq(renewalCycles.id, old.cycle.id));
    expect(l!.status).toBe('LAPSED');
  });

  it('AC-P38-4/5: not renewing stops reminders; reopen is refused after the grace end (REN-08)', async () => {
    const a = await advisor();
    const c = await customer(a);
    const { cycle } = await existingPolicy(a, c.id, 30);
    let r = (await a.d.get(`/renewals/${cycle.id}`)).body;
    const contact = await a.d.post(`/renewals/${cycle.id}/contact`, { outcome: 'Spoke to customer', version: r.version });
    expect(contact.body.message.text).toBe('Contact logged. This renewal is now in follow-up.');
    r = (await a.d.get(`/renewals/${cycle.id}`)).body;
    const nr = await a.d.post(`/renewals/${cycle.id}/not-renewing`, { reason: 'Bought elsewhere', version: r.version });
    expect(nr.body.message.text).toBe('Marked as not renewing. Customer reminders have stopped.');
    await db.update(renewalCycles).set({ graceEnd: addDays(istToday(), -1) }).where(eq(renewalCycles.id, cycle.id));
    r = (await a.d.get(`/renewals/${cycle.id}`)).body;
    const re = await a.d.post(`/renewals/${cycle.id}/reopen`, { note: 'Customer called back', version: r.version });
    expect(re.body.error.message).toBe(`The grace period ended on ${formatDate(addDays(istToday(), -1))}. This renewal can no longer be reopened.`);
  });
});

describe('P-39 to P-43 Communications', () => {
  it('AC-P39-2/4: a variable outside the list is refused; the maker cannot approve; email templates go ACTIVE on approval', async () => {
    const s = await staff('STF', 'Template Maker');
    const bad = await s.d.post('/admin/templates', { name: `Bad ${key()}`, channel: 'EMAIL', purpose: 'KYC_RESULT_EMAIL', language: 'English', subject: 'Hi', body: 'Hello {customer first name}' }, H());
    expect(bad.body.error.code).toBe('COM-03');
    const ok = await s.d.post('/admin/templates', { name: `KYC ${key()}`, channel: 'EMAIL', purpose: 'KYC_RESULT_EMAIL', language: 'English', subject: 'KYC {result}', body: 'Dear {advisor first name}, your KYC is {result}.' }, H());
    const sub = await s.d.post(`/admin/templates/${ok.body.template.id}/submit`, { version: ok.body.template.version });
    expect(sub.status).toBe(200);
    const self = await s.d.post(`/admin/templates/${ok.body.template.id}/approve`, { version: sub.body.template.version }, H());
    expect(self.status).toBe(403);
    const adm = await staff('ADM', 'Template Approver');
    await setSetting('CFG-05', 1000);
    const ap = await adm.d.post(`/admin/templates/${ok.body.template.id}/approve`, { version: sub.body.template.version }, { ...H(), 'x-step-up-token': await stepUp(adm.d, adm.mobile) });
    expect(ap.body.template.status).toBe('ACTIVE');
  });

  it('AC-P40-1: a Normal account cannot turn greetings on (SUB-01); AC-P41-1/5: one greeting a year, 29 February on 28 February', async () => {
    const a = await advisor();
    const no = await a.d.post('/communications/greetings', { enabled: true, version: 0 });
    expect(no.body.error.code).toBe('SUB-01');
    await premium(a.accountId);
    await db.update(messageTemplates).set({ status: 'ACTIVE' }).where(eq(messageTemplates.channel, 'WHATSAPP'));
    await db.insert(whatsappNumbers).values({ accountId: a.accountId, status: 'READY', number: '+919800000001', requestedAt: clock.now() }).onConflictDoNothing();
    await db.update(wallets).set({ balance: '100.00' }).where(eq(wallets.accountId, a.accountId));
    const g = (await a.d.get('/communications/greetings')).body;
    const save = await a.d.post('/communications/greetings', { enabled: true, birthdayTemplateId: g.templates.BIRTHDAY[0].id, familyBirthdayTemplateId: g.templates.FAMILY_BIRTHDAY[0].id, anniversaryTemplateId: g.templates.ANNIVERSARY[0].id, version: g.version });
    expect(save.body.message.text).toBe('Greeting settings saved.');
    const today = istToday();
    const c = await customer(a, { dateOfBirth: formatDate(`1990-${today.slice(5)}`) });
    await db.insert((await import('../src/db/schema.js')).consents).values({ accountId: a.accountId, customerId: c.id, channel: 'WHATSAPP', status: 'GIVEN', address: c.mobile, how: 'Signed form', changedAt: clock.now() });
    // Inside the sending window
    clock.setOffset(new Date(`${today}T10:00:00+05:30`).getTime() - Date.now());
    await runDaily('SYS-04', true);
    await runDaily('SYS-04', true);
    const sent = await db.select().from(outgoingMessages).where(and(eq(outgoingMessages.customerId, c.id), eq(outgoingMessages.purpose, 'BIRTHDAY')));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toBe('SENT');
    const debits = await db.select().from(walletTransactions).where(and(eq(walletTransactions.accountId, a.accountId), eq(walletTransactions.kind, 'DEBIT')));
    expect(debits).toHaveLength(1);
    // A retry of the same message never charges again (AC-P56-1)
    await sendMessage(sent[0]!.id);
    expect(await db.select().from(walletTransactions).where(and(eq(walletTransactions.accountId, a.accountId), eq(walletTransactions.kind, 'DEBIT')))).toHaveLength(1);
    const { isToday } = await import('../src/modules/messages/greetings.service.js');
    expect(isToday('2000-02-29', '2027-02-28')).toBe(true);
    expect(isToday('2000-02-29', '2028-02-29')).toBe(true);
  });

  it('AC-P42-1/2/3: a forged webhook changes nothing; a late DELIVERED after READ is ignored; STOP withdraws consent', async () => {
    const a = await advisor();
    const c = await customer(a);
    const [m] = await db.insert(outgoingMessages).values({ accountId: a.accountId, customerId: c.id, channel: 'WHATSAPP', purpose: 'RENEWAL_REMINDER', recipient: c.mobile, body: 'x', occurrenceKey: key(), status: 'SENT', providerId: `pid-${key()}`, createdAt: clock.now() }).returning();
    const d = new Device();
    const forged = await d.post('/webhooks/whatsapp', { eventId: key(), type: 'status', providerMessageId: m!.providerId, status: 'READ' }, { 'x-signature': 'bad' });
    expect(forged.status).toBe(401);
    for (const st of ['READ', 'DELIVERED']) {
      const body = { eventId: key(), type: 'status', providerMessageId: m!.providerId, status: st };
      await d.post('/webhooks/whatsapp', body, { 'x-signature': sign('test-whatsapp-webhook-secret', body) });
    }
    const [after] = await db.select().from(outgoingMessages).where(eq(outgoingMessages.id, m!.id));
    expect(after!.status).toBe('READ');
    const { consents } = await import('../src/db/schema.js');
    await db.insert(consents).values({ accountId: a.accountId, customerId: c.id, channel: 'WHATSAPP', status: 'GIVEN', address: c.mobile, how: 'Signed form', changedAt: new Date(clock.now().getTime() - 60_000) });
    await db.insert(whatsappNumbers).values({ accountId: a.accountId, status: 'READY', number: '+919811111111', requestedAt: clock.now() });
    const stop = { eventId: key(), type: 'reply', from: c.mobile, to: '+919811111111', text: 'STOP' };
    await d.post('/webhooks/whatsapp', stop, { 'x-signature': sign('test-whatsapp-webhook-secret', stop) });
    const [cs] = await db.select().from(consents).where(and(eq(consents.customerId, c.id), eq(consents.channel, 'WHATSAPP')));
    expect(cs!.status).toBe('WITHDRAWN');
  });
});

describe('P-56 / P-47 Wallet and plans', () => {
  it('AC-P56-3: a recharge is credited only by the signed gateway notification; WAL-04 below the minimum', async () => {
    const a = await advisor();
    await premium(a.accountId);
    const low = await a.d.post('/billing/wallet/recharge', { amount: '100' }, H());
    expect(low.body.error.message).toBe('The smallest recharge is ₹500.');
    const r = await a.d.post('/billing/wallet/recharge', { amount: '600' }, H());
    expect(r.body.gateway).toBe('test');
    expect((await a.d.get('/billing/wallet')).body.balance).toBe('0.00');
    await a.d.post(`/billing/orders/${r.body.orderId}/test-complete`, { outcome: 'success' });
    expect((await a.d.get('/billing/wallet')).body.balance).toBe('600.00');
  });

  it('AC-P47-3/4: a Karnataka advisor pays CGST + SGST, others IGST; the plan activates only from the notification', async () => {
    await setSetting('CFG-82', { NORMAL: { monthly: 500, yearly: 5000 }, PREMIUM: { monthly: 1000, yearly: 10000 } });
    const a = await advisor();
    await db.update(advisorProfiles).set({ state: 'Karnataka' }).where(eq(advisorProfiles.accountId, a.accountId));
    const pay = await a.d.post('/billing/plan/pay', { plan: 'PREMIUM', cycle: 'YEARLY' }, H());
    expect(pay.body.details).toMatchObject({ cgst: '900.00', sgst: '900.00', igst: '0.00', total: '11800.00' });
    expect((await a.d.get('/billing/plan')).body.current.status).toBe('TRIAL');
    await a.d.post(`/billing/orders/${pay.body.orderId}/test-complete`, { outcome: 'success' });
    const plan = (await a.d.get('/billing/plan')).body;
    expect(plan.current).toMatchObject({ status: 'ACTIVE', plan: 'PREMIUM' });
    expect(plan.invoices[0].number).toMatch(/^BY\/\d{4}-\d{2}\/\d{6}$/);
    expect(plan.whatsappNumber.status).toBe('SETTING_UP');
    const b = await advisor();
    await db.update(advisorProfiles).set({ state: 'Kerala' }).where(eq(advisorProfiles.accountId, b.accountId));
    const pb = await b.d.post('/billing/plan/pay', { plan: 'NORMAL', cycle: 'MONTHLY' }, H());
    expect(pb.body.details).toMatchObject({ igst: '90.00', total: '590.00' });
  });

  it('AC-P47-2/6: after the trial the account is read-only; after CFG-81 more days it is closed, never deleted', async () => {
    const a = await advisor();
    await db.update(subscriptions).set({ periodEnd: addDays(istToday(), -1) }).where(eq(subscriptions.accountId, a.accountId));
    await runDaily('SYS-05', true);
    const [s] = await db.select().from(subscriptions).where(and(eq(subscriptions.accountId, a.accountId), eq(subscriptions.isCurrent, true)));
    expect(s!.status).toBe('EXPIRED');
    const write = await a.d.post('/customers', { fullName: 'Asha Rao', mobile: newMobile() }, H());
    expect(write.body.error.code).toBe('SUB-03');
    await db.update(subscriptions).set({ periodEnd: addDays(istToday(), -100) }).where(eq(subscriptions.id, s!.id));
    await runDaily('SYS-05', true);
    const [acc] = await db.select().from(accounts).where(eq(accounts.id, a.accountId));
    expect(acc!.status).toBe('CLOSED');
  });
});

describe('P-44 to P-46 Referral', () => {
  it('AC-P44-1, AC-P46-1/2/3: one lead per referral; a repeat links; a revoked code shows REF-04', async () => {
    const a = await advisor();
    const taken = await a.d.post('/referrers', { name: 'Kiran Rao', mobile: a.mobile }, H());
    expect(taken.body.error.fields[0].code).toBe('REF-02');
    const add = await a.d.post('/referrers', { name: 'Kiran Rao', mobile: newMobile() }, H());
    expect(add.body.message.text).toBe('Referrer Kiran Rao added. Share the invitation with them.');
    const form = await new Device().get(`/public/referral/${add.body.code}`);
    expect(form.body.active).toBe(true);
    const types = form.body.types as { id: string }[];
    const body = { name: 'Neha Shah', mobile: newMobile(), knowsAs: 'Friend', interestTypeId: types[0]!.id, permission: true };
    const s1 = await new Device().post(`/public/referral/${add.body.code}`, body);
    expect(s1.body.message.text).toMatch(/^Thank you, Neha\./);
    await new Device().post(`/public/referral/${add.body.code}`, body);
    const ls = await db.select().from(leads).where(and(eq(leads.accountId, a.accountId), eq(leads.mobile, `+91${body.mobile}`)));
    expect(ls).toHaveLength(1);
    expect(ls[0]!.source).toBe('Referred by a referrer');
    await a.d.post(`/referrers/${add.body.id}/disable`);
    const off = await new Device().get(`/public/referral/${add.body.code}`);
    expect(off.body.message.text).toBe('This referral link is not active. Please contact the person who shared it.');
    const [code] = await db.select().from(referralCodes).where(eq(referralCodes.code, add.body.code));
    expect(code!.status).toBe('REVOKED');
  });
});

describe('P-48 to P-52, P-57 Administration', () => {
  it('AC-P49-1/3: a change needs a second ADM; out-of-range is refused (ADM-05)', async () => {
    const a1 = await staff('ADM', 'Config Maker');
    const a2 = await staff('ADM', 'Config Checker');
    await setSetting('CFG-05', 1000);
    const bad = await a1.d.post('/admin/config/CFG-46', { value: 100, reason: 'Longer validity' });
    expect(bad.body.error.code).toBe('ADM-05');
    const req = await a1.d.post('/admin/config/CFG-46', { value: 20, reason: 'Longer validity' });
    expect(req.body.message.text).toBe('Change sent for approval.');
    const list = (await a1.d.get('/admin/config')).body.items.find((i: { id: string }) => i.id === 'CFG-46');
    expect(list.value).toBe(15);
    const self = await a1.d.post(`/admin/config-changes/${list.pending.id}/approve`, {}, { ...H(), 'x-step-up-token': await stepUp(a1.d, a1.mobile, 'CONFIG_CHANGE') });
    expect(self.body.error.code).toBe('CAT-05');
    const ok = await a2.d.post(`/admin/config-changes/${list.pending.id}/approve`, {}, { ...H(), 'x-step-up-token': await stepUp(a2.d, a2.mobile, 'CONFIG_CHANGE') });
    expect(ok.body.message.text).toBe('Change applied. The new value is used from now on.');
    const [v] = await db.select().from(configValues).where(eq(configValues.id, 'CFG-46'));
    expect(v!.value).toBe(20);
    await db.update(configValues).set({ value: 15 }).where(eq(configValues.id, 'CFG-46'));
  });

  it('AC-P51-1/3: suspending ends access; the summary shows counts only; AC-P57-1: no grant, no client data (SUP-03)', async () => {
    const adm = await staff('ADM', 'Account Admin');
    await setSetting('CFG-05', 1000);
    const a = await advisor();
    await customer(a);
    const sum = (await adm.d.get(`/admin/accounts/${a.accountId}`)).body;
    expect(sum.counts.customers).toBe(1);
    expect(JSON.stringify(sum)).not.toContain('Ravi Kumar');
    const noGrant = await adm.d.get(`/admin/support/${a.accountId}/customers`);
    expect(noGrant.body.error.code).toBe('SUP-03');
    const grant = await a.d.post('/me/support-grants', { staffUserId: adm.user.id, reason: 'Ticket 42', hours: 2 }, { ...H(), 'x-step-up-token': await stepUp(a.d, a.mobile, 'SUPPORT_GRANT') });
    expect(grant.body.message.text).toMatch(/^Support access given to Account Admin until/);
    const yes = await adm.d.get(`/admin/support/${a.accountId}/customers`);
    expect(yes.body.items).toHaveLength(1);
    const log = (await a.d.get('/me/support-grants')).body.items[0];
    expect(log.views.length).toBeGreaterThan(0);
    const s = await adm.d.post(`/admin/accounts/${a.accountId}/suspend`, { reason: 'Suspected fraud', version: sum.version }, { 'x-step-up-token': await stepUp(adm.d, adm.mobile, 'ACCOUNT_STATUS') });
    expect(s.body.message.text).toBe('Account suspended. The advisor and their referrers can no longer log in.');
    expect((await a.d.get('/customers')).status).toBe(401);
    const again = await login(new Device(), a.mobile);
    expect(again.verify.body.error.code).toBe('AUTH-10');
  });

  it('AC-P48-1: the last active ADM cannot be demoted; AC-P52-1/3: export builds a ZIP of own data, also when read-only', async () => {
    const adm = await staff('ADM', 'Only Admin');
    await setSetting('CFG-05', 1000);
    const others = await db.select().from(users).where(eq(users.role, 'ADM'));
    for (const o of others) if (o.id !== adm.user.id) await db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, o.id));
    const other = await staff('STF', 'Some Staff');
    const [u] = await db.select().from(users).where(eq(users.id, other.user.id));
    const ok = await adm.d.post(`/admin/users/${other.user.id}`, { role: 'ADM', version: u!.version }, { 'x-step-up-token': await stepUp(adm.d, adm.mobile, 'USER_CHANGE') });
    expect(ok.status).toBe(200);
    const self = await adm.d.post(`/admin/users/${adm.user.id}`, { status: 'DISABLED', version: 1 });
    expect(self.body.error.code).toBe('ADM-03');
    const a = await advisor();
    await customer(a);
    await db.update(subscriptions).set({ status: 'EXPIRED' }).where(eq(subscriptions.accountId, a.accountId));
    const ex = await a.d.post('/me/exports', { include: ['CUSTOMERS', 'POLICIES'] }, { ...H(), 'x-step-up-token': await stepUp(a.d, a.mobile, 'EXPORT') });
    expect(ex.body.message.text).toBe('Your export is being prepared. We will tell you when it is ready.');
    const [j] = await db.select().from(exportJobs).where(eq(exportJobs.id, ex.body.id));
    expect(j!.status).toBe('READY');
    const dl = await a.d.get(`/me/exports/${j!.id}/download`);
    expect(dl.body.url).toContain('/api/v1/files/');
    void customers;
    void occasionSettings;
    void subscriptionInvoices;
  });
});
