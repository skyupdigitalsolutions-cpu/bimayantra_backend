// P-08 Advisor dashboard. Each widget has its own API call scoped to the account, so one failing widget
// never blanks the page. Counts for leads, customers, quotations, policies and renewals are added with
// those modules (Phases 4–5).
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { advisorProfiles, auditLog } from '../../db/schema.js';
import { addDays, formatDate, istToday } from '../../lib/clock.js';
import { msg } from '../../messages/messages.js';
import { currentSubscription } from '../accounts/accounts.service.js';
import { completionView, recalc } from '../profile/profile.service.js';
import { settings } from '../settings/settings.service.js';
import { todaysTasks } from '../tasks/tasks.service.js';

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Banners: trial days left (SUB-04), grace period (SUB-05), read-only (SUB-03). */
export async function banners(accountId: string) {
  const s = await currentSubscription(db, accountId);
  if (!s) return [];
  const today = istToday();
  if (s.status === 'TRIAL') return [{ ...msg('SUB-04', { days: Math.max(0, daysBetween(today, s.periodEnd) + 1) }), tone: 'amber' }];
  if (s.status === 'GRACE') {
    const graceEnd = addDays(s.periodEnd, settings.get('CFG-79'));
    return [{ ...msg('SUB-05', { date: formatDate(s.periodEnd), days: Math.max(0, daysBetween(today, graceEnd)) }), tone: 'amber' }];
  }
  if (s.status === 'EXPIRED') return [{ ...msg('SUB-03'), tone: 'red' }];
  return [];
}

/** Profile completion card (hidden at 100%). */
export async function profileCard(accountId: string) {
  const c = await recalc(db, accountId);
  return c.percent >= 100 ? null : completionView(c);
}

export async function tasksWidget(accountId: string) {
  const items = await todaysTasks(accountId);
  return { items, empty: items.length ? null : msg('DSH-04') };
}

// Record events shown in Recent activity: created, status changed, message sent — not sign-ins or views
const ACTIVITY: Record<string, string> = {
  TASK_CREATED: 'Task created',
  TASK_DONE: 'Task marked as done',
  TASK_REOPENED: 'Task reopened',
  TASK_CANCELLED: 'Task cancelled',
  PROFILE_SECTION_SAVED: 'Profile updated',
  KYC_SUBMITTED: 'KYC submitted for review',
  KYC_VERIFIED: 'KYC verified',
  KYC_REJECTED: 'KYC not accepted',
  INSURER_MAPPING_ADDED: 'Insurer added',
  INSURER_MAPPING_DEACTIVATED: 'Insurer deactivated',
  INSURER_MAPPING_ACTIVATED: 'Insurer activated',
  ASSISTANT_ADDED: 'Assistant added',
  ASSISTANT_DISABLED: 'Assistant disabled',
  ACCOUNT_CREATED: 'Account created',
};

export async function recentActivity(accountId: string) {
  const rows = await db
    .select({ at: auditLog.at, action: auditLog.action, entity: auditLog.entity, entityId: auditLog.entityId, newValue: auditLog.newValue })
    .from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), inArray(auditLog.action, Object.keys(ACTIVITY)), eq(auditLog.result, 'SUCCESS')))
    .orderBy(desc(auditLog.at))
    .limit(settings.get('CFG-130'));
  return {
    items: rows.map((r) => {
      const v = (r.newValue ?? {}) as Record<string, unknown>;
      const detail = typeof v.title === 'string' ? v.title : typeof v.insurer === 'string' ? v.insurer : typeof v.section === 'string' ? v.section : typeof v.name === 'string' ? v.name : null;
      return { at: r.at.toISOString(), text: detail ? `${ACTIVITY[r.action]}: ${detail}` : ACTIVITY[r.action], link: { type: r.entity, id: r.entityId } };
    }),
    empty: rows.length ? null : msg('DSH-04'),
  };
}

/** The account's display name for assistants' header (P-53 step 2). */
export async function accountName(accountId: string) {
  const [p] = await db.select({ businessName: advisorProfiles.businessName, fullName: advisorProfiles.fullName }).from(advisorProfiles).where(eq(advisorProfiles.accountId, accountId));
  return p ? (p.businessName ?? p.fullName) : null;
}
