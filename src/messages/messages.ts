// The message catalogue (Section 21): every user-facing text, by message ID, exactly as written in the
// Business Process Document. A wording change is a document change first (Section 1.3).
// Placeholders in curly brackets are filled at run time; {CFG-xx} always shows the live setting (GR-08).
import { readFileSync } from 'node:fs';
import { SETTINGS, type SettingId } from '../config/settings.js';
import { settings } from '../modules/settings/settings.service.js';

type Entry = { text: string; used: string; retired: boolean };
const catalogue = JSON.parse(readFileSync(new URL('./messages.json', import.meta.url), 'utf8')) as Record<string, Entry>;

export type MessageId = string;
export type Params = Record<string, string | number | undefined>;

export function hasMessage(id: string): boolean {
  return id in catalogue && !catalogue[id]!.retired;
}

/** Render a message: {CFG-xx} from live settings, anything else from params (left as-is if missing). */
export function render(id: MessageId, params: Params = {}): string {
  const entry = catalogue[id];
  if (!entry) throw new Error(`Unknown message ID ${id}`);
  return entry.text.replace(/\{([^{}]+)\}/g, (whole, key: string) => {
    if (/^CFG-\d+$/.test(key) && key in SETTINGS) return formatSetting(settings.get(key as SettingId));
    // Placeholder names are matched ignoring capitals ({Record type} and {record type} are the same)
    const v = params[key] ?? Object.entries(params).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
    return v === undefined ? whole : String(v);
  });
}

function formatSetting(v: unknown): string {
  if (typeof v === 'object' && v !== null && 'min' in v && 'max' in v) return `${String(v.min)} to ${String(v.max)}`;
  return String(v);
}

export function allMessageIds(): string[] {
  return Object.keys(catalogue);
}

/** A message for a success response: the ID (for the app) and the exact text (for display). */
export function msg(id: MessageId, params: Params = {}): { code: string; text: string } {
  return { code: id, text: render(id, params) };
}
