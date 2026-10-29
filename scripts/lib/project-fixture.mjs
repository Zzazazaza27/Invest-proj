/**
 * Общая обстановка для проверок проекта: подключение к базе владельцем,
 * слепой индекс почты, набор согласий и проект основателя.
 *
 * Раньше эти помощники жили в фикстуре расчёта стоимости раунда; раунды,
 * пакеты и условия стран удалены в 2.1-W05, а проверкам изображений и
 * страницы проекта по-прежнему нужен обычный проект. Он создаётся тем же
 * путём, что и в кабинете, — через API основателя.
 */
import pg from 'pg';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadDotEnv() {
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

export function makePool(name) {
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL_OWNER,
    max: 4,
    application_name: name,
  });
}

export function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

export const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

/** Проект основателя через API — так же, как его создают в кабинете. */
export async function createProject(client, sql, suffix) {
  const [{ id: taxonomyId }] = await sql(
    `SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech' LIMIT 1`,
  );
  const project = await client.json('/v1/projects', {
    method: 'POST',
    body: {
      title: `Прогон проекта ${suffix}`,
      tagline: 'Проект прогона: изображения и страница проекта',
      stage: 'mvp',
      taxonomyId,
      investmentAsk: '1500000.00',
      askCurrency: 'RUB',
      geoCountry: 'RU',
    },
  });
  return { project };
}
