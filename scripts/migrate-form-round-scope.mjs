#!/usr/bin/env node
/**
 * Перевод живой конфигурации вопросов на разделение «профиль / раунд»
 * (план 0.2 §0г, заявка-03 §2.4, §2.7; этап 5.6.2).
 *
 * Работает с тем, что фактически опубликовано и правится администратором,
 * а не с исходным seed: берёт активную опубликованную версию (с её текстами,
 * переводами и состояниями), ставит разделу `funding` признак
 * `scope: 'round'`, переносит вопрос `previous_funding` в конец раздела
 * `traction` (история проекта — часть профиля) и публикует следующий номер
 * версии с основанием. То же преобразование применяется к существующему
 * административному черновику на месте. Снимки поданных заявок и черновики
 * заявок на прежних версиях не трогаются: они остаются на своих версиях.
 *
 * Идемпотентно: если активная версия уже переведена, а черновик тоже — ничего
 * не делает. Повторный запуск не публикует вторую версию.
 *
 * Запуск:  node scripts/migrate-form-round-scope.mjs [--dry-run]
 *   NODE_ENV=test — тестовая БД (DATABASE_URL_TEST).
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
const REASON =
  'Разделение профиля и раунда: раздел «Инвестиционный запрос» — раунд; «Предыдущее финансирование» — в «Результаты и динамика» (план 0.2 §0г, этап 5.6.2)';

/** Возвращает новый документ или null, если преобразовывать нечего. */
function transform(config) {
  const next = JSON.parse(JSON.stringify(config));
  let changed = false;
  const funding = next.sections.find((s) => s.key === 'funding');
  if (funding && funding.scope !== 'round') {
    funding.scope = 'round';
    changed = true;
  }
  for (const s of next.sections) {
    if (s.key !== 'funding' && s.scope === undefined) {
      s.scope = 'profile';
      changed = true;
    }
  }
  const moved = next.questions.find((q) => q.key === 'previous_funding');
  if (moved && moved.section === 'funding' && next.sections.some((s) => s.key === 'traction')) {
    const last = Math.max(
      0,
      ...next.questions.filter((q) => q.section === 'traction').map((q) => q.order),
    );
    moved.section = 'traction';
    moved.order = last + 10;
    changed = true;
  }
  return changed ? next : null;
}

const client = new pg.Client({
  connectionString: url,
  application_name: 'migrate-form-round-scope',
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
      `активная версия ${current.version} уже переведена; черновик ${draft ? 'тоже' : 'отсутствует'} — делать нечего`,
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
        `funding.scope=round, previous_funding → traction`,
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
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}
