import type { AppSettingRecord, Db } from "./types";

export function listAppSettings(db: Db): AppSettingRecord[] {
  return db.prepare(`
    SELECT *
    FROM app_settings
    ORDER BY setting_key ASC
  `).all() as unknown as AppSettingRecord[];
}

export function getAppSettingByKey(db: Db, settingKey: string): AppSettingRecord | null {
  return (db.prepare(`
    SELECT *
    FROM app_settings
    WHERE setting_key = ?
  `).get(normalizeText(settingKey)) as unknown as AppSettingRecord | undefined) ?? null;
}

export function upsertAppSetting(
  db: Db,
  {
    settingKey,
    value,
  }: {
    settingKey: string;
    value: unknown;
  },
): AppSettingRecord | null {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_settings (
      setting_key,
      value_json,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(setting_key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `).run(
    normalizeText(settingKey),
    JSON.stringify(value ?? null),
    now,
    now,
  );

  return getAppSettingByKey(db, settingKey);
}

function normalizeText(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error("App setting key must not be empty");
  }

  return normalized;
}
