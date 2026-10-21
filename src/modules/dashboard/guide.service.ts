// "What to do next" guides, so an advisor always knows the next step without training:
//   gettingStarted: the advisor's set-up checklist on the Dashboard (profile → KYC → insurers → customer →
//                   quotation → policy), each step with its link.
//   customerJourney: one customer's path (customer → ID document → quotation → proposal → policy) and the
//                    single next action for that customer.
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { advisorKyc, advisorProfiles, consents, customers, documentVersions, documents, insurerMappings, policies, proposals, quotationRevisions, quotations } from '../../db/schema.js';
import { istToday } from '../../lib/clock.js';
import { notFound } from '../../lib/errors.js';
import { isUuid } from '../catalogue/common.js';

type Step = { key: string; title: string; text: string; state: 'DONE' | 'WAITING' | 'TODO'; href: string; action: string };
const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);
const countOf = sql<number>`count(*)::int`;

export async function gettingStarted(accountId: string) {
  const [p] = await db.select().from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  const [k] = await db.select({ status: advisorKyc.status }).from(advisorKyc).where(eq(advisorKyc.accountId, accountId));
  const insurers = n(await db.select({ n: countOf }).from(insurerMappings).where(and(eq(insurerMappings.accountId, accountId), eq(insurerMappings.status, 'ACTIVE'))));
  const custs = n(await db.select({ n: countOf }).from(customers).where(eq(customers.accountId, accountId)));
  const quotes = n(await db.select({ n: countOf }).from(quotations).where(and(eq(quotations.accountId, accountId), isNotNull(quotations.number))));
  const pols = n(await db.select({ n: countOf }).from(policies).where(eq(policies.accountId, accountId)));
  const today = istToday();
  const licenceOk = !!p?.licenceNumber && !!p.licenceValidUntil && p.licenceValidUntil >= today;
  const profileOk = licenceOk && (p?.authorisedTypeIds.length ?? 0) > 0;
  const kyc = k?.status ?? 'NOT_SUBMITTED';
  const steps: Step[] = [
    {
      key: 'profile', title: 'Complete your profile', href: '/settings/profile', action: 'Open profile',
      text: profileOk ? 'Licence and insurance types are set.' : !licenceOk ? 'Add your IRDAI licence number and its expiry date.' : 'Choose the insurance types your licence allows (Health, Life, Motor…).',
      state: profileOk ? 'DONE' : 'TODO',
    },
    {
      key: 'kyc', title: 'Verify your KYC', href: '/settings/kyc', action: kyc === 'REJECTED' ? 'Fix KYC' : 'Open KYC',
      text: kyc === 'VERIFIED' ? 'Verified by SkyUp.' : kyc === 'PENDING_REVIEW' ? 'Sent. SkyUp is checking it.' : kyc === 'REJECTED' ? 'SkyUp asked for a correction.' : 'Upload your PAN and licence.',
      state: kyc === 'VERIFIED' ? 'DONE' : kyc === 'PENDING_REVIEW' ? 'WAITING' : 'TODO',
    },
    {
      key: 'insurers', title: 'Add the insurers you sell for', href: '/settings/insurers', action: 'Add insurer',
      text: insurers ? `${insurers} insurer${insurers > 1 ? 's' : ''} added with your agent code.` : 'Add each insurer with your agent code. Only their products can be quoted.',
      state: insurers ? 'DONE' : 'TODO',
    },
    {
      key: 'customer', title: 'Add your customers', href: custs ? '/customers' : '/customers/import', action: custs ? 'Open customers' : 'Import from Excel',
      text: custs ? `${custs} customer${custs > 1 ? 's' : ''} added.` : 'Import your Excel list in one go, or add them one by one.',
      state: custs ? 'DONE' : 'TODO',
    },
    {
      key: 'quotation', title: 'Make your first quotation', href: '/products', action: 'Open products',
      text: quotes ? `${quotes} quotation${quotes > 1 ? 's' : ''} made.` : 'Products → compare → Create quotation → share the PDF on WhatsApp.',
      state: quotes ? 'DONE' : 'TODO',
    },
    {
      key: 'policy', title: 'Record your first policy', href: '/policies', action: 'Open policies',
      text: pols ? `${pols} polic${pols > 1 ? 'ies' : 'y'} recorded.` : 'From a quotation: Start proposal → payment → policy. Or add an existing policy.',
      state: pols ? 'DONE' : 'TODO',
    },
  ];
  return { steps, done: steps.filter((s) => s.state === 'DONE').length, total: steps.length };
}

export async function customerJourney(accountId: string, customerId: string) {
  if (!isUuid(customerId)) throw notFound();
  const [c] = await db.select({ id: customers.id, status: customers.status, fullName: customers.fullName, dateOfBirth: customers.dateOfBirth }).from(customers).where(and(eq(customers.id, customerId), eq(customers.accountId, accountId)));
  if (!c) throw notFound();
  const [consent] = await db.select({ status: consents.status }).from(consents)
    .where(and(eq(consents.customerId, c.id), isNull(consents.familyMemberId), eq(consents.channel, 'PERSONAL_DATA'))).orderBy(desc(consents.changedAt)).limit(1);
  const idDocs = n(await db.select({ n: countOf }).from(documents).innerJoin(documentVersions, eq(documentVersions.documentId, documents.id))
    .where(and(eq(documents.customerId, c.id), isNull(documents.familyMemberId), inArray(documents.type, ['Aadhaar', 'PAN']), eq(documentVersions.status, 'CONFIRMED'))));
  const [q] = await db.select({ id: quotations.id, number: quotations.number }).from(quotations).where(eq(quotations.customerId, c.id)).orderBy(desc(quotations.createdAt)).limit(1);
  const [rev] = q ? await db.select({ id: quotationRevisions.id }).from(quotationRevisions).where(eq(quotationRevisions.quotationId, q.id)).orderBy(desc(quotationRevisions.revisionNo)).limit(1) : [];
  const [pr] = await db.select({ id: proposals.id, number: proposals.number, status: proposals.status }).from(proposals).where(eq(proposals.customerId, c.id)).orderBy(desc(proposals.createdAt)).limit(1);
  const [po] = await db.select({ id: policies.id, number: policies.number }).from(policies).where(eq(policies.customerId, c.id)).orderBy(desc(policies.createdAt)).limit(1);

  const consentGiven = consent?.status === 'GIVEN';
  const steps = [
    { key: 'customer', label: 'Customer', done: true, href: `/customers/${c.id}` },
    { key: 'id', label: 'Aadhaar / PAN', done: idDocs > 0, href: `/customers/${c.id}?tab=documents` },
    { key: 'quotation', label: 'Quotation', done: !!q?.number, href: rev ? `/quotations/r/${rev.id}` : '/products' },
    { key: 'proposal', label: 'Proposal', done: !!pr && pr.status !== 'DRAFT' && pr.status !== 'CANCELLED', href: pr ? `/proposals/${pr.id}` : '' },
    { key: 'policy', label: 'Policy', done: !!po, href: po ? `/policies/${po.id}` : '' },
  ];
  // the one next action for this customer
  let next: { text: string; action: string; href: string } | null;
  if (c.status !== 'ACTIVE') next = null;
  else if (!idDocs && !consentGiven) next = { text: `Record ${c.fullName}'s consent, then upload Aadhaar or PAN. The details fill in by themselves.`, action: 'Record consent', href: `/customers/${c.id}?tab=consent` };
  else if (!idDocs) next = { text: `Upload ${c.fullName}'s Aadhaar or PAN. Name, date of birth and gender fill in by themselves.`, action: 'Upload Aadhaar / PAN', href: `/customers/${c.id}?tab=documents&upload=1` };
  else if (!q) next = { text: `Find the right plan for ${c.fullName} and make a quotation.`, action: 'Find products', href: '/products' };
  else if (!q.number) next = { text: 'A quotation is still a draft. Finish it and share the PDF.', action: 'Continue quotation', href: rev ? `/quotations/r/${rev.id}` : '/quotations' };
  else if (!pr) next = { text: `Quotation ${q.number} is ready. When ${c.fullName} agrees, start the proposal.`, action: 'Open quotation', href: rev ? `/quotations/r/${rev.id}` : '/quotations' };
  else if (!po) next = { text: `Proposal ${pr.number}: finish it, collect the payment, then record the policy.`, action: 'Open proposal', href: `/proposals/${pr.id}` };
  else next = { text: `Policy ${po.number} is recorded. Renewal reminders come automatically.`, action: 'Open policy', href: `/policies/${po.id}` };
  if (next && !c.dateOfBirth && idDocs) next = { text: `Add ${c.fullName}'s date of birth: it is needed for quotations.`, action: 'Add date of birth', href: `/customers/${c.id}` };
  return { steps, next };
}
