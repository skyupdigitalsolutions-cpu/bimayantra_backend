// Admin → Approvals (P-25 step 1): every pending item, oldest first, with maker and date. Price versions
// need no approval (v3.1); message templates and configuration changes join this list in Phase 6.
import { reviewQueue } from '../kyc/kyc.service.js';
import { correctionQueue } from './corrections.service.js';
import { pendingInsurers } from './insurers.service.js';
import { pendingProductVersions } from './products.service.js';
import { pendingTypeItems } from './types.service.js';
import type { AuthContext } from '../../types/express.js';
import { pendingTemplates } from '../messages/templates.service.js';
import { pendingConfig } from '../admin/admin.service.js';

export const APPROVAL_KINDS = ['INSURER', 'INSURER_CHANGE', 'TYPE', 'TYPE_CHANGE', 'TEMPLATE', 'PRODUCT_VERSION', 'KYC', 'CORRECTION', 'MESSAGE_TEMPLATE', 'CONFIG'] as const;

export async function approvalsList(auth: AuthContext) {
  const [ins, types, prods, kyc, corrections, tpls, cfg] = await Promise.all([pendingInsurers(), pendingTypeItems(), pendingProductVersions(), reviewQueue(), correctionQueue(), pendingTemplates(), pendingConfig()]);
  const items = [
    ...ins,
    ...types,
    ...prods,
    ...tpls,
    ...cfg,
    ...kyc.map((k) => ({ kind: 'KYC', id: k.accountId, title: k.fullName, makers: [k.fullName], makerIds: [] as string[], submittedAt: k.submittedAt })),
    ...corrections.map((c) => ({ kind: 'CORRECTION', id: c.id, title: `${c.productName ?? 'Product'}: ${c.fieldLabel}`, makers: [c.by], makerIds: [] as string[], submittedAt: c.createdAt })),
  ];
  return items
    .map((i) => ({
      ...i,
      // The person who made it cannot approve it (CAT-05); the screen shows why instead of the button
      youMadeThis: i.makerIds.includes(auth.userId),
    }))
    .sort((a, b) => new Date(a.submittedAt ?? 0).getTime() - new Date(b.submittedAt ?? 0).getTime());
}
