#!/usr/bin/env node
/**
 * Стартовая видимость группы «текущий запрос» и предмета финансирования —
 * `investors` (владелец, 2026-09-18, уточнение к 5.6.4): сумма раунда по
 * умолчанию скрыта от анонимного посетителя, публичность — явная настройка
 * в админке.
 *
 * Скрипт работает по ЖИВОЙ конфигурации, а не по сиду: если у активной
 * опубликованной версии вопросы `investment_ask`, `funding_scope`,
 * `funding_scope_note` стоят в `public`, публикуется новая версия с
 * `investors` (основание — эта причина); административный черновик
 * переводится на месте. Остальные значения (`investors`, `platform`,
 * `private`) не трогаются — это уже осознанная настройка. Идемпотентен:
 * повторный запуск ничего не меняет. `--dry-run` — показать без записи.
 *
 *   node scripts/migrate-form-round-visibility.mjs [--dry-run]
 *   NODE_ENV=test node scripts/migrate-form-round-visibility.mjs   # тестовая БД
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();
const url =
  process.env.NODE_ENV === 'test' ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL_OWNER;
if (!url) {
  console.error('Не задана строка подключения (DATABASE_URL_OWNER или DATABASE_URL_TEST).');
  process.exit(1);
}
const dryRun = process.argv.includes('--dry-run');
const KEYS = ['investment_ask', 'funding_scope', 'funding_scope_note'];
const REASON =
  'Сумма раунда и предмет финансирования по умолчанию скрыты от анонимного посетителя: видимость investors; публичность — явная настройка (владелец 2026-09-18, этап 5.6.4)';

function transform(config) {
  const next = JSON.parse(JSON.stringify(config));
  let changed = false;
  for (const q of next.questions ?? []) {
    if (KEYS.includes(q.key) && q.visibility === 'public') {
      q.visibility = 'investors';
      changed = true;
    }
  }
  return changed ? next : null;
}

const client = new pg.Client({
  connectionString: url,
  application_name: 'migrate-form-round-visibility',
});
await client.connect();
try {
  await client.query('BEGIN');
  const { rows: active } = await client.query(
    `SELECT id, version, config_jsonb FROM lab.application_form_versions
      WHERE status = 'published' AND is_active FOR UPDATE`,
  );
  if (active.length === 0) {
    console.error('Нет активной версии конфигурации — сначала scripts/seed-application-form.mjs');
    process.exit(1);
  }
  const current = active[0];
  const nextConfig = transform(current.config_jsonb);

  const { rows: drafts } = await client.query(
    `SELECT id, config_jsonb FROM lab.application_form_versions WHERE status = 'draft' FOR UPDATE`,
  );
  const draft = drafts[0] ?? null;
  const nextDraft = draft ? transform(draft.config_jsonb) : null;

  if (!nextConfig && !nextDraft) {
    console.warn(
      `активная версия ${current.version}: группа «текущий запрос» уже не public; черновик ${draft ? 'тоже' : 'отсутствует'} — делать нечего`,
    );
    await client.query('ROLLBACK');
    process.exit(0);
  }

  if (nextConfig) {
    const { rows: max } = await client.query(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM lab.application_form_versions`,
    );
    const version = Number(max[0].next);
    console.warn(
      `${dryRun ? '[пробно] ' : ''}активная версия ${current.version} → публикуется версия ${version}: ` +
        `${KEYS.join(', ')}: public → investors`,
    );
    if (!dryRun) {
      await client.query(
        `UPDATE lab.application_form_versions SET is_active = false WHERE is_active`,
      );
      await client.query(
        `INSERT INTO lab.application_form_versions
           (id, version, status, is_active, config_jsonb, based_on_version, reason, published_at, activated_at)
         VALUES (public.uuid_generate_v7(), $1, 'published', true, $2::jsonb, $3, $4, now(), now())`,
        [version, JSON.stringify(nextConfig), current.version, REASON],
      );
    }
  }
  if (nextDraft && draft) {
    console.warn(`${dryRun ? '[пробно] ' : ''}административный черновик переведён на месте`);
    if (!dryRun) {
      await client.query(
        `UPDATE lab.application_form_versions SET config_jsonb = $2::jsonb, updated_at = now() WHERE id = $1`,
        [draft.id, JSON.stringify(nextDraft)],
      );
    }
  }
  await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  console.warn(dryRun ? 'пробный запуск: ничего не записано' : 'готово');
} finally {
  await client.end();
}

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] === undefined) process.env[key] = trimmed.slice(eq + 1).trim();
  }
}
