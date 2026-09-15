#!/usr/bin/env node
/**
 * Стартовая конфигурация вопросов заявки — публикация версии 1.
 *
 * Документ версии 1 живёт в коде контрактов (`application-form.v1.ts`,
 * сгенерирован из банка вопросов). Миграция M073 создаёт таблицу версий, но
 * не вписывает в SQL документ на сотню вопросов с текстами — его публикует
 * этот скрипт. Идемпотентно: если опубликованные версии уже есть (в том числе
 * изменённые владельцем в админке), скрипт ничего не делает — действующая
 * конфигурация после первой публикации живёт в БД, а не в коде.
 *
 * Запись идёт от владельца схем под FORCE RLS: политики таблицы требуют роль
 * администратора, поэтому контекст сессии выставляется явно на время
 * транзакции. Событие аудита не пишется (как и у сида политик в M071):
 * это фикстура окружения, а не действие пользователя.
 *
 * Запуск:  node scripts/seed-application-form.mjs [--dry-run]
 *   NODE_ENV=test — публикует в тестовую БД (DATABASE_URL_TEST).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { APPLICATION_FORM_V1, ApplicationFormConfigSchema } = require('@unicorn/contracts');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DRY = process.argv.includes('--dry-run');
loadDotEnv();

const url =
  process.env.NODE_ENV === 'test' ? process.env.DATABASE_URL_TEST : process.env.DATABASE_URL_OWNER;
if (!url || url.includes('CHANGE_ME')) {
  console.error(
    'Не задана строка подключения (DATABASE_URL_OWNER или DATABASE_URL_TEST при NODE_ENV=test).',
  );
  process.exit(1);
}

const parsed = ApplicationFormConfigSchema.safeParse(APPLICATION_FORM_V1);
if (!parsed.success) {
  console.error(
    'Документ версии 1 не проходит схему:',
    JSON.stringify(parsed.error.issues, null, 1),
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, application_name: 'seed-application-form' });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('app.current_roles', 'admin', true)`);
  const { rows } = await client.query(
    `SELECT version, is_active FROM lab.application_form_versions
      WHERE status = 'published' ORDER BY version`,
  );
  if (rows.length > 0) {
    const active = rows.find((r) => r.is_active)?.version ?? '—';
    process.stdout.write(
      `опубликованных версий: ${rows.length} (активна ${active}) — сид не нужен\n`,
    );
    await client.query('ROLLBACK');
  } else if (DRY) {
    process.stdout.write(
      `dry-run: опубликовал бы версию 1 — ${parsed.data.sections.length} разделов, ${parsed.data.questions.length} вопросов\n`,
    );
    await client.query('ROLLBACK');
  } else {
    await client.query(
      `INSERT INTO lab.application_form_versions
         (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
       VALUES (public.uuid_generate_v7(), 1, 'published', true, $1::jsonb, $2, now(), now())`,
      [
        JSON.stringify(parsed.data),
        'Стартовая конфигурация версии 1 из банка вопросов (каталог v2, план 0.2 §0в.5)',
      ],
    );
    await client.query('COMMIT');
    process.stdout.write(
      `опубликована версия 1: ${parsed.data.sections.length} разделов, ${parsed.data.questions.length} вопросов\n`,
    );
  }
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
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
