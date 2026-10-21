// P-39 template purposes, allowed variables and rendering. Template management screens are in
// templates.service.ts; senders only ever use an ACTIVE template (checked again at send time).
import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '../../db/client.js';
import { messageTemplates } from '../../db/schema.js';

export const PURPOSES = ['BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY', 'RENEWAL_REMINDER', 'QUOTATION_EMAIL', 'KYC_RESULT_EMAIL', 'SUBSCRIPTION_REMINDER_EMAIL'] as const;
export type Purpose = (typeof PURPOSES)[number];
export const PURPOSE_NAMES: Record<Purpose, string> = {
  BIRTHDAY: 'Birthday greeting',
  FAMILY_BIRTHDAY: 'Family birthday greeting',
  ANNIVERSARY: 'Anniversary greeting',
  RENEWAL_REMINDER: 'Renewal reminder',
  QUOTATION_EMAIL: 'Quotation email',
  KYC_RESULT_EMAIL: 'KYC result email',
  SUBSCRIPTION_REMINDER_EMAIL: 'Subscription reminder email',
};
/** System purposes allow exactly one ACTIVE template per channel and language (P-39 step 5). */
export const SYSTEM_PURPOSES: readonly Purpose[] = ['RENEWAL_REMINDER', 'QUOTATION_EMAIL', 'KYC_RESULT_EMAIL', 'SUBSCRIPTION_REMINDER_EMAIL'];
export const GREETING_PURPOSES: readonly Purpose[] = ['BIRTHDAY', 'FAMILY_BIRTHDAY', 'ANNIVERSARY'];
/** Which channels make sense per purpose. */
export const PURPOSE_CHANNELS: Record<Purpose, readonly ('WHATSAPP' | 'EMAIL')[]> = {
  BIRTHDAY: ['WHATSAPP'],
  FAMILY_BIRTHDAY: ['WHATSAPP'],
  ANNIVERSARY: ['WHATSAPP'],
  RENEWAL_REMINDER: ['WHATSAPP', 'EMAIL'],
  QUOTATION_EMAIL: ['EMAIL'],
  KYC_RESULT_EMAIL: ['EMAIL'],
  SUBSCRIPTION_REMINDER_EMAIL: ['EMAIL'],
};
export const VARIABLES: Record<Purpose, readonly string[]> = {
  BIRTHDAY: ['person first name', 'advisor name', 'business name', 'advisor mobile'],
  FAMILY_BIRTHDAY: ['customer first name', 'person first name', 'relationship', 'advisor name', 'business name', 'advisor mobile'],
  ANNIVERSARY: ['customer first name', 'advisor name', 'business name', 'advisor mobile'],
  RENEWAL_REMINDER: ['customer first name', 'product', 'policy last 4', 'renewal date', 'advisor name', 'advisor mobile'],
  QUOTATION_EMAIL: ['customer first name', 'insurance type', 'product', 'final payable', 'valid until', 'quotation link', 'advisor name', 'advisor mobile', 'advisor email'],
  KYC_RESULT_EMAIL: ['advisor first name', 'result', 'reason'],
  SUBSCRIPTION_REMINDER_EMAIL: ['advisor first name', 'plan', 'end date'],
};
export const SAMPLE: Record<string, string> = {
  'person first name': 'Asha',
  'customer first name': 'Ravi',
  relationship: 'Daughter',
  'advisor name': 'Priya Sharma',
  'advisor first name': 'Priya',
  'business name': 'Sharma Insurance Services',
  'advisor mobile': '+91 98450 12345',
  'advisor email': 'priya@example.com',
  product: 'Family Health Plan',
  'policy last 4': '4821',
  'renewal date': '15-11-2026',
  'insurance type': 'Health',
  'final payable': '₹18,408.00',
  'valid until': '30-10-2026',
  'quotation link': 'https://app.bimayantra.in/q/…',
  result: 'Verified',
  reason: '—',
  plan: 'Premium',
  'end date': '31-10-2026',
};

/** The variables used in a text, as written inside curly brackets. */
export const variablesIn = (text: string) => [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());

/** Fill {variable} placeholders, ignoring capitals. Unknown ones stay as written. */
export function fill(text: string, vars: Record<string, string>): string {
  const lower = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k.toLowerCase(), v]));
  return text.replace(/\{([^{}]+)\}/g, (whole, key: string) => lower[key.trim().toLowerCase()] ?? whole);
}

export type Template = typeof messageTemplates.$inferSelect;
export async function activeTemplate(dbx: DbOrTx, purpose: Purpose, channel: 'WHATSAPP' | 'EMAIL', id?: string | null): Promise<Template | undefined> {
  const [t] = await dbx
    .select()
    .from(messageTemplates)
    .where(and(eq(messageTemplates.purpose, purpose), eq(messageTemplates.channel, channel), eq(messageTemplates.status, 'ACTIVE'), id ? eq(messageTemplates.id, id) : undefined))
    .orderBy(asc(messageTemplates.createdAt))
    .limit(1);
  return t;
}

/** Built-in texts used to seed the first ACTIVE templates (released with the product, document change 40). */
export const DEFAULT_TEMPLATES: { name: string; channel: 'WHATSAPP' | 'EMAIL'; purpose: Purpose; metaCategory?: string; subject?: string; body: string }[] = [
  {
    name: 'Quotation email',
    channel: 'EMAIL',
    purpose: 'QUOTATION_EMAIL',
    subject: 'Your {insurance type} quotation from {advisor name}',
    body: 'Dear {customer first name},\n\nPlease find your quotation for {product}. The final payable premium is {final payable}, valid until {valid until}.\n\nView it online: {quotation link}\n\nFor any questions, call {advisor name} on {advisor mobile} or reply to this email ({advisor email}).',
  },
  {
    name: 'Renewal reminder email',
    channel: 'EMAIL',
    purpose: 'RENEWAL_REMINDER',
    subject: 'Your {product} policy is due for renewal',
    body: 'Dear {customer first name}, your {product} policy ending {policy last 4} is due for renewal on {renewal date}. Please contact {advisor name} on {advisor mobile} to renew it on time.',
  },
  {
    name: 'Renewal reminder WhatsApp',
    channel: 'WHATSAPP',
    purpose: 'RENEWAL_REMINDER',
    metaCategory: 'UTILITY',
    body: 'Dear {customer first name}, your {product} policy ending {policy last 4} is due for renewal on {renewal date}. Please contact {advisor name} on {advisor mobile} to renew it on time.',
  },
  {
    name: 'Birthday wishes',
    channel: 'WHATSAPP',
    purpose: 'BIRTHDAY',
    metaCategory: 'MARKETING',
    body: 'Happy birthday, {person first name}! Wishing you good health and happiness. — {advisor name}, {business name} ({advisor mobile})',
  },
  {
    name: 'Family birthday wishes',
    channel: 'WHATSAPP',
    purpose: 'FAMILY_BIRTHDAY',
    metaCategory: 'MARKETING',
    body: 'Dear {customer first name}, wishing your {relationship} {person first name} a very happy birthday! — {advisor name}, {business name} ({advisor mobile})',
  },
  {
    name: 'Anniversary wishes',
    channel: 'WHATSAPP',
    purpose: 'ANNIVERSARY',
    metaCategory: 'MARKETING',
    body: 'Happy anniversary, {customer first name}! Warm wishes from {advisor name}, {business name} ({advisor mobile}).',
  },
];
