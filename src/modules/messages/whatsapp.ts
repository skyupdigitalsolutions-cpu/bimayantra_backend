// WhatsApp Business provider (automated messages from the advisor's dedicated number, Premium).
// Only approved templates are sent; no free text is ever added (P-41 backend rules).
// http = a provider-neutral HTTP API (document change 41): POST {from, to, template, variables} with a bearer key,
// answering {id}; 4xx = permanent failure, 5xx or network error = temporary failure (retried, GR-27).
import { env } from '../../config/env.js';

export type WaSend = { from: string; to: string; template: string; language: string; variables: Record<string, string>; text: string };
export type WaResult = { ok: true; providerId: string } | { ok: false; permanent: boolean; error: string };
export const sentWhatsapp: WaSend[] = [];

export const whatsappAvailable = () => env.WHATSAPP_PROVIDER !== 'none';

export async function sendWhatsapp(m: WaSend): Promise<WaResult> {
  switch (env.WHATSAPP_PROVIDER) {
    case 'memory':
      sentWhatsapp.push(m);
      if (m.to.endsWith('0000000000')) return { ok: false, permanent: true, error: 'Not on WhatsApp' };
      return { ok: true, providerId: `wa-${sentWhatsapp.length}-${Date.now()}` };
    case 'log':
      console.log(`[DEV WHATSAPP] ${m.from} → ${m.to}: ${m.text}`);
      return { ok: true, providerId: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    case 'http': {
      try {
        const r = await fetch(env.WHATSAPP_API_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${env.WHATSAPP_API_KEY}` },
          body: JSON.stringify({ from: m.from, to: m.to, template: m.template, language: m.language, variables: m.variables }),
          signal: AbortSignal.timeout(15_000),
        });
        const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
        if (r.ok && body.id) return { ok: true, providerId: body.id };
        return { ok: false, permanent: r.status >= 400 && r.status < 500, error: body.error ?? `HTTP ${r.status}` };
      } catch (err) {
        return { ok: false, permanent: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    default:
      return { ok: false, permanent: true, error: 'WhatsApp provider not set up' };
  }
}
