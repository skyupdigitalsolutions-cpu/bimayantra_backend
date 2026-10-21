// Hooks that later modules fill in, so leads and customers do not depend on them:
// - open items that block deactivating a customer (P-19: READY or SHARED quotations, AWAITING_PAYMENT
//   payments — registered by the quotation and payment modules)
// - cancelling QUEUED messages when consent is withdrawn, a number changes, or a person is deactivated
//   (registered by the communications module, P-39 to P-43)
import type { DbOrTx } from '../../db/client.js';

export type OpenItem = { type: string; number: string };
type OpenItemsCheck = (tx: DbOrTx, accountId: string, customerId: string) => Promise<OpenItem[]>;
type CancelMessages = (tx: DbOrTx, scope: { accountId: string; customerId: string; familyMemberId?: string | null; channel?: string; address?: string }) => Promise<number>;

const openChecks: OpenItemsCheck[] = [];
const cancellers: CancelMessages[] = [];

export const registerOpenItemsCheck = (fn: OpenItemsCheck) => void openChecks.push(fn);
export const registerMessageCanceller = (fn: CancelMessages) => void cancellers.push(fn);

export async function openItemsFor(tx: DbOrTx, accountId: string, customerId: string): Promise<OpenItem[]> {
  const all = await Promise.all(openChecks.map((fn) => fn(tx, accountId, customerId)));
  return all.flat();
}

export async function cancelQueuedMessages(tx: DbOrTx, scope: Parameters<CancelMessages>[1]): Promise<number> {
  let n = 0;
  for (const fn of cancellers) n += await fn(tx, scope);
  return n;
}
