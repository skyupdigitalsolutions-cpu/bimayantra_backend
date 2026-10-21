// Email provider. Messages are queued (job "send-email") so a provider failure never undoes the business
// record (GR-26); temporary failures are retried by the queue (GR-27).
import nodemailer from 'nodemailer';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { defineJob, enqueue } from '../jobs/jobs.js';
import { getFile, readStored } from '../files/files.service.js';

export type Email = {
  to: string;
  subject: string;
  text: string;
  dedupeKey: string;
  replyTo?: string | null;
  attachments?: { filename: string; fileId: string }[];
  /** Extra plain-text footer, for example the unsubscribe link on emails to customers (P-42). */
  footer?: string | null;
};
export const sentEmails: Email[] = [];

const transport = env.EMAIL_PROVIDER === 'smtp' ? nodemailer.createTransport(env.SMTP_URL) : null;

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Send now. Returns the provider's message ID when it gives one. Throws on failure (the caller retries). */
export async function deliver(e: Email): Promise<string | null> {
  if (env.EMAIL_PROVIDER === 'memory') {
    sentEmails.push(e);
    return `mem-${sentEmails.length}-${Date.now()}`;
  }
  if (env.EMAIL_PROVIDER === 'console') {
    console.log(`[DEV EMAIL] to ${e.to}: ${e.subject} — ${e.text}${e.attachments?.length ? ` [${e.attachments.map((a) => a.filename).join(', ')}]` : ''}`);
    return null;
  }
  const attachments = [];
  for (const a of e.attachments ?? []) {
    const f = await getFile(a.fileId);
    if (f) attachments.push({ filename: a.filename, content: await readStored(f.storageKey), contentType: f.mime });
  }
  const footer = e.footer ?? env.APP_URL;
  const paras = e.text.split(/\n+/).map((p) => `<p>${escape(p).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`).join('');
  const info = await transport!.sendMail({
    from: env.EMAIL_FROM,
    to: e.to,
    ...(e.replyTo ? { replyTo: e.replyTo } : {}),
    subject: e.subject,
    text: `${e.text}\n\n${footer}`,
    html: `<div style="font-family:Arial,sans-serif;font-size:15px;color:#13213a">${paras}<p style="color:#5f6f86;font-size:13px">${escape(footer).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p></div>`,
    attachments,
  });
  return typeof info.messageId === 'string' ? info.messageId : null;
}

defineJob('send-email', async (data) => {
  const e = data as unknown as Email;
  try {
    await deliver(e);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), dedupeKey: e.dedupeKey }, 'Email failed');
    throw err; // the queue retries
  }
});

export async function sendEmail(e: Email): Promise<void> {
  await enqueue('send-email', e, { singletonKey: e.dedupeKey });
}
