// SMS provider (OTP and account notices). Indian numbers only; DLT-registered templates (P-01 backend rules).
// console: prints to the terminal for local development (refused in production by env.ts).
// memory:  keeps messages in a list for automated tests.
// msg91:   MSG91 Flow API. The DLT template must use the variables ##otp## and ##minutes##.
import { env } from '../../config/env.js';
import { TECHNICAL } from '../../config/technical.js';
import { logger } from '../../lib/logger.js';
import { maskMobile } from '../../lib/mask.js';

export type SmsMessage =
  | { kind: 'OTP'; to: string; code: string; minutes: number }
  | { kind: 'MOBILE_CHANGED'; to: string; newMaskedMobile: string };

export class SmsSendError extends Error {}

/** Messages sent by the memory provider (tests read OTP codes from here). */
export const sentSms: SmsMessage[] = [];

async function msg91(templateId: string, to: string, vars: Record<string, string>): Promise<void> {
  const res = await fetch('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey: env.MSG91_AUTH_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [{ mobiles: to.replace(/^\+/, ''), ...vars }] }),
    signal: AbortSignal.timeout(TECHNICAL.smsTimeoutMs),
  });
  const body = (await res.json().catch(() => ({}))) as { type?: string };
  if (!res.ok || body.type === 'error') throw new SmsSendError(`MSG91 refused (${res.status})`);
}

export const sms = {
  /** Throws SmsSendError when the provider is down or refuses (the caller shows AUTH-13). */
  async send(message: SmsMessage): Promise<void> {
    const masked = maskMobile(message.to);
    try {
      switch (env.SMS_PROVIDER) {
        case 'memory':
          sentSms.push(message);
          return;
        case 'console':
          // Development only. The code is printed to the terminal, never to the structured log.
          if (message.kind === 'OTP') console.log(`[DEV SMS] ${message.code} is your Bimayantra verification code (to ${masked})`);
          else console.log(`[DEV SMS] Mobile number changed notice to ${masked}`);
          return;
        case 'msg91':
          if (message.kind === 'OTP') await msg91(env.MSG91_OTP_TEMPLATE_ID, message.to, { otp: message.code, minutes: String(message.minutes) });
          else if (env.MSG91_MOBILE_CHANGED_TEMPLATE_ID)
            await msg91(env.MSG91_MOBILE_CHANGED_TEMPLATE_ID, message.to, { mobile: message.newMaskedMobile });
          else logger.warn('MSG91_MOBILE_CHANGED_TEMPLATE_ID not set; mobile-changed notice not sent');
          return;
      }
    } catch (err) {
      logger.warn({ to: masked, kind: message.kind, err: err instanceof Error ? err.message : String(err) }, 'SMS send failed');
      throw err instanceof SmsSendError ? err : new SmsSendError('SMS provider unavailable');
    }
  },
};
