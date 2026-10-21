// Live configuration values (P-49): every request and job reads CFG values from here (NFR-13).
// Defaults come from src/config/settings.ts and are written to the database on start-up; a changed
// value in the database (approved by a second admin, P-49) is picked up within a few seconds.
import { sql } from 'drizzle-orm';
import { SETTINGS, SETTING_IDS, type SettingId, type SettingValue } from '../../config/settings.js';
import { db } from '../../db/client.js';
import { configValues } from '../../db/schema.js';

const REFRESH_MS = 5_000;
const cache = new Map<string, unknown>();
let loadedAt = 0;

export const settings = {
  get<K extends SettingId>(id: K): SettingValue<K> {
    return (cache.has(id) ? cache.get(id) : SETTINGS[id].value) as SettingValue<K>;
  },
  /** Write any missing defaults (never overwrites a value an admin changed) and load the cache. */
  async init(): Promise<void> {
    const rows = SETTING_IDS.map((id) => ({
      id,
      value: SETTINGS[id].value,
      defaultValue: SETTINGS[id].value,
      changeBy: SETTINGS[id].changeBy,
    }));
    await db
      .insert(configValues)
      .values(rows)
      .onConflictDoUpdate({
        target: configValues.id,
        // Release settings follow the code; ADM settings keep the admin's value, only the default is refreshed
        set: {
          defaultValue: sql`excluded.default_value`,
          changeBy: sql`excluded.change_by`,
          value: sql`case when excluded.change_by = 'Release' then excluded.value else ${configValues.value} end`,
        },
      });
    await settings.refresh();
  },
  async refresh(): Promise<void> {
    const rows = await db.select({ id: configValues.id, value: configValues.value }).from(configValues);
    cache.clear();
    for (const r of rows) cache.set(r.id, r.value);
    loadedAt = Date.now();
  },
  async refreshIfStale(): Promise<void> {
    if (Date.now() - loadedAt > REFRESH_MS) await settings.refresh();
  },
};
