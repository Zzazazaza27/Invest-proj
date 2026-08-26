#!/usr/bin/env node
/**
 * Переанализ проектов действующей моделью скоринга.
 *
 * Зачем: после включения LLM-провайдера (или смены промпта) паспорта на
 * платформе остаются от прежней модели. Здесь каждый проект прогоняется через
 * обычный маршрут `POST /v1/projects/:id/analysis` от имени администратора —
 * тем же путём, что и основатель: с квотой, журналом, правилами в коде,
 * фильтром выхода и переводом. Никаких обходов сервиса.
 *
 *   node scripts/reanalyze-projects.mjs                 все проекты, по 2 параллельно
 *   node scripts/reanalyze-projects.mjs --only-listed   только опубликованные
 *   node scripts/reanalyze-projects.mjs --limit 5       первые N (для пробы)
 *   node scripts/reanalyze-projects.mjs --concurrency 3
 *   node scripts/reanalyze-projects.mjs --dry-run       только список
 *
 * Учётка администратора — из окружения: REANALYZE_ADMIN_EMAIL (по умолчанию
 * stand-admin@unicorn.local) и REANALYZE_ADMIN_PASSWORD (по умолчанию
 * DEV_TEST_USER_PASSWORD из .env). Пароль в аргументы не передаётся и не печатается.
 *
 * Список проектов читается из БД владельцем схем (DATABASE_URL_OWNER): это
 * единственное, что делается мимо API, и это чтение идентификаторов.
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_URL } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const onlyListed = argv.includes('--only-listed');
const dryRun = argv.includes('--dry-run');
const limit = Number(arg('--limit', '0'));
const concurrency = Math.max(1, Math.min(4, Number(arg('--concurrency', '2'))));

const BASE = process.env.CORE_URL || CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';
const ADMIN_EMAIL = process.env.REANALYZE_ADMIN_EMAIL ?? 'stand-admin@unicorn.local';
const ADMIN_PASSWORD = process.env.REANALYZE_ADMIN_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD;

function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    process.env[key] ??= value;
  }
}

function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // Один анализ моделью — минуты: ядро ждёт шлюз до AI_GATEWAY_TIMEOUT_MS.
      signal: AbortSignal.timeout(660_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* не JSON */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { response, json };
  }
  return { call };
}

async function listProjects() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 });
  try {
    const { rows } = await pool.query(
      `SELECT id, title, listed_at IS NOT NULL AS listed
         FROM lab.projects
        WHERE deleted_at IS NULL ${onlyListed ? 'AND listed_at IS NOT NULL' : ''}
        ORDER BY created_at`,
    );
    return rows;
  } finally {
    await pool.end();
  }
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.error(
      'нет пароля администратора: задай REANALYZE_ADMIN_PASSWORD или DEV_TEST_USER_PASSWORD',
    );
    process.exit(2);
  }
  let projects = await listProjects();
  if (limit > 0) projects = projects.slice(0, limit);
  console.warn(
    `проектов к анализу: ${projects.length}${onlyListed ? ' (только опубликованные)' : ''}`,
  );
  if (dryRun) {
    for (const p of projects) console.warn(`  ${p.id}  ${p.listed ? '●' : '○'}  ${p.title}`);
    return;
  }

  const client = makeClient();
  const login = await client.call('/v1/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!login.response.ok) {
    console.error(
      `вход администратора не удался: ${login.response.status} ${login.json?.code ?? ''}`,
    );
    process.exit(2);
  }

  const results = [];
  let index = 0;
  const startedAt = Date.now();
  async function worker() {
    while (index < projects.length) {
      const p = projects[index++];
      const t0 = Date.now();
      let outcome;
      try {
        const { response, json } = await client.call(`/v1/projects/${p.id}/analysis`, {
          method: 'POST',
          body: {},
        });
        outcome = response.ok
          ? {
              ok: true,
              provider: json?.provider,
              isLlm: json?.isLlm,
              score10: json?.score10,
              irs: json?.irs,
              passportVersion: json?.passportVersion,
            }
          : { ok: false, status: response.status, code: json?.code, detail: json?.detail };
      } catch (error) {
        outcome = {
          ok: false,
          code: error?.name ?? 'error',
          detail: String(error?.message ?? error),
        };
      }
      const seconds = ((Date.now() - t0) / 1000).toFixed(0);
      results.push({ project: p, ...outcome });
      const mark = outcome.ok ? 'OK ' : 'ERR';
      const tail = outcome.ok
        ? `${outcome.provider}${outcome.isLlm ? '' : ' (не LLM)'} · балл ${outcome.score10 ?? '—'}/10 · IRS ${outcome.irs} · v${outcome.passportVersion}`
        : `${outcome.status ?? ''} ${outcome.code ?? ''} ${outcome.detail ?? ''}`.trim();
      console.warn(
        `  ${mark} ${String(results.length).padStart(3)}/${projects.length} ${seconds.padStart(4)}с  ${p.title.slice(0, 40).padEnd(40)}  ${tail}`,
      );
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const ok = results.filter((r) => r.ok);
  const llm = ok.filter((r) => r.isLlm);
  const failed = results.filter((r) => !r.ok);
  console.warn('');
  console.warn(
    `итог: ${ok.length}/${results.length} успешно, из них моделью ${llm.length}; ошибок ${failed.length}; ` +
      `${Math.round((Date.now() - startedAt) / 1000)} с`,
  );
  if (failed.length) {
    const byCode = {};
    for (const f of failed) byCode[f.code ?? '?'] = (byCode[f.code ?? '?'] ?? 0) + 1;
    console.warn('ошибки по кодам:', JSON.stringify(byCode));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('переанализ прерван:', error?.message ?? error);
  process.exit(1);
});
