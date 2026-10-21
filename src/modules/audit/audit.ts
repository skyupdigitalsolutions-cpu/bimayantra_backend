// GR-30 audit log. Write it with the same transaction handle as the change it records, so either both
// exist or neither does. The table refuses UPDATE and DELETE (database trigger, see drizzle/ migrations).
// Never put an OTP, token, full PAN or full Aadhaar in old/new values; mobiles are masked (GR-31).
import type { Request } from 'express';
import type { DbOrTx } from '../../db/client.js';
import { auditLog } from '../../db/schema.js';
import { clock } from '../../lib/clock.js';

export type AuditEntry = {
  action: string;
  entity: string;
  entityId?: string | null;
  accountId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  result?: 'SUCCESS' | 'FAILURE';
  /** Who did it: a signed-in user, or a system job name. */
  actor?: { userId?: string | null; role?: string | null; job?: string | null };
};

export async function audit(dbx: DbOrTx, req: Request | null, entry: AuditEntry): Promise<void> {
  const actor = entry.actor ?? (req?.auth ? { userId: req.auth.userId, role: req.auth.role } : {});
  await dbx.insert(auditLog).values({
    at: clock.now(),
    actorUserId: actor.userId ?? null,
    actorRole: actor.role ?? null,
    actorJob: actor.job ?? null,
    accountId: entry.accountId ?? req?.auth?.accountId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    oldValue: entry.oldValue ?? null,
    newValue: entry.newValue ?? null,
    result: entry.result ?? 'SUCCESS',
    requestId: req?.requestId ?? null,
    ip: req?.ip ?? null,
  });
}
