// P-35 nominee rules, shared by proposals (P-55), issued-policy recording (P-33) and nominee changes.
// Shares are summed with exact decimals (in hundredths); a minor nominee needs an adult appointee.
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { familyMembers } from '../../db/schema.js';
import { istToday } from '../../lib/clock.js';
import { AppError, fieldErrors, notFound, type FieldError } from '../../lib/errors.js';
import * as F from '../../lib/fields.js';
import { settings } from '../settings/settings.service.js';
import { normName } from '../clients/common.js';
import { ageOn } from '../quotations/engine.js';

export type Nominee = {
  familyMemberId: string | null;
  name: string;
  relationship: string;
  dateOfBirth: string;
  sharePercent: string;
  appointee: { name: string; relationship: string; dateOfBirth: string } | null;
  mobile: string | null;
};

const cents = (p: string) => {
  const [w, f = ''] = p.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
};
const fmt = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;

/** Validate and normalise a nominee list. `max` is the product's limit (never more than CFG-53). */
export async function parseNominees(dbx: DbOrTx, customer: { id: string; fullName: string }, raw: unknown, max: number | null): Promise<Nominee[]> {
  const list = Array.isArray(raw) ? raw : [];
  const limit = Math.min(max ?? settings.get('CFG-53'), settings.get('CFG-53'));
  const relationships = settings.get('CFG-36') as readonly string[];
  const minShare = cents(String(settings.get('CFG-55')));
  const total = cents(String(settings.get('CFG-54')));
  const adultAge = settings.get('CFG-56');
  const errors: FieldError[] = [];
  if (list.length > limit) throw new AppError(422, 'POL-11', { max: limit }, [{ field: 'nominees', code: 'POL-11', params: { max: limit } }]);
  const out: Nominee[] = [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const b = (item ?? {}) as Record<string, unknown>;
    const at = (f: string) => `nominees.${i}.${f}`;
    const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
    let name = '';
    let dob: string | null = null;
    let familyMemberId: string | null = null;
    if (typeof b.familyMemberId === 'string' && b.familyMemberId) {
      const [m] = await dbx.select().from(familyMembers).where(and(eq(familyMembers.id, b.familyMemberId), eq(familyMembers.customerId, customer.id)));
      if (!m) throw notFound(); // a family member of another customer (GEN-11)
      familyMemberId = m.id;
      name = m.fullName;
      dob = m.dateOfBirth;
    } else {
      const r = F.personName(str(b.name));
      if (!b.name) errors.push({ field: at('name'), code: 'GEN-01', params: { 'Field label': 'Full name' } });
      else if (!r.ok) errors.push({ field: at('name'), code: r.code, ...(r.params ? { params: r.params } : {}) });
      else name = r.value;
    }
    const rel = str(b.relationship);
    if (!rel) errors.push({ field: at('relationship'), code: 'GEN-01', params: { 'Field label': 'Relationship' } });
    else if (!relationships.includes(rel)) errors.push({ field: at('relationship'), code: 'VAL-22' });
    const dobRaw = typeof b.dateOfBirth === 'string' && b.dateOfBirth ? b.dateOfBirth : dob;
    if (!dobRaw) errors.push({ field: at('dateOfBirth'), code: 'GEN-01', params: { 'Field label': 'Date of birth' } });
    else {
      const r = F.dateOfBirth(dobRaw);
      if (!r.ok) errors.push({ field: at('dateOfBirth'), code: r.code, ...(r.params ? { params: r.params } : {}) });
      else dob = r.value;
    }
    const shareRaw = str(b.sharePercent);
    let share = '';
    if (!shareRaw) errors.push({ field: at('sharePercent'), code: 'GEN-01', params: { 'Field label': 'Share %' } });
    else {
      const r = F.percentage(shareRaw);
      if (!r.ok) errors.push({ field: at('sharePercent'), code: r.code, ...(r.params ? { params: r.params } : {}) });
      else if (cents(r.value) < minShare) errors.push({ field: at('sharePercent'), code: 'POL-12' });
      else share = r.value;
    }
    let mobile: string | null = null;
    if (b.mobile) {
      const r = F.mobile(str(b.mobile));
      if (!r.ok) errors.push({ field: at('mobile'), code: r.code });
      else mobile = r.value;
    }
    if (name && normName(name) === normName(customer.fullName) && !familyMemberId) errors.push({ field: at('name'), code: 'POL-14' });
    const key = familyMemberId ?? `${normName(name)}|${dob ?? ''}`;
    if (name && seen.has(key)) errors.push({ field: at('name'), code: 'POL-15', params: { Name: name } });
    seen.add(key);
    let appointee: Nominee['appointee'] = null;
    const age = dob ? ageOn(dob, istToday()) : null;
    if (age !== null && age < adultAge) {
      const a = (b.appointee ?? null) as Record<string, unknown> | null;
      if (!a || !a.name) errors.push({ field: at('appointee.name'), code: 'POL-16', params: { Name: name } });
      else {
        const an = F.personName(str(a.name));
        const ar = str(a.relationship);
        const ad = F.dateOfBirth(str(a.dateOfBirth));
        if (!an.ok) errors.push({ field: at('appointee.name'), code: an.code });
        if (!relationships.includes(ar)) errors.push({ field: at('appointee.relationship'), code: ar ? 'VAL-22' : 'GEN-01', params: { 'Field label': 'Appointee relationship' } });
        if (!ad.ok) errors.push({ field: at('appointee.dateOfBirth'), code: a.dateOfBirth ? ad.code : 'GEN-01', params: { 'Field label': 'Appointee date of birth' } });
        else if ((ageOn(ad.value, istToday()) ?? 0) < adultAge) errors.push({ field: at('appointee.dateOfBirth'), code: 'POL-17' });
        if (an.ok && ad.ok && relationships.includes(ar)) appointee = { name: an.value, relationship: ar, dateOfBirth: ad.value };
      }
    }
    out.push({ familyMemberId, name, relationship: rel, dateOfBirth: dob ?? '', sharePercent: share, appointee, mobile });
  }
  if (errors.length) throw fieldErrors(errors);
  if (out.length) {
    const sum = out.reduce((t, n) => t + cents(n.sharePercent), 0);
    if (sum !== total) throw new AppError(422, 'POL-13', { total: fmt(sum) }, [{ field: 'nominees', code: 'POL-13', params: { total: fmt(sum) } }]);
  }
  return out;
}

export const nomineeSummary = (policyNumber: string, list: Nominee[]) => `Nominees for policy ${policyNumber}: ${list.map((n) => `${n.name} ${n.sharePercent}%`).join(', ')}`;
