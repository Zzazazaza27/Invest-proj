#!/usr/bin/env node
/**
 * Служебная учётка мониторинга — только чтение контрольных данных
 * (требование 2.5; 2.1-W08a — замечание Тэнка при приёмке).
 *
 * Изнутри настоящей сессии учётки (с CSRF-токеном — отказ должен давать
 * ограничение учётки, а не защита от подделки запроса):
 *  * контрольное чтение — работает;
 *  * изменение профиля, загрузка и удаление аватара, чтение своего профиля —
 *    отказ;
 *  * обычный проект С выданным ей разрешением (выдаётся здесь же и сразу
 *    отзывается) — отказ;
 *  * «кто я» — разрешено.
 *
 * Нужны стенд, `monitor-probe-init.mjs` и сессия от `monitor-app-probe.mjs`.
 *
 *   node scripts/check-monitoring-account.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ROOT, loadEnv } from './lib/backup.mjs';

loadEnv();
const env = process.env;
const BASE = (env.MONITOR_PUBLIC_URL || 'http://127.0.0.1').replace(/\/$/, '');
const privateDir = resolve(env.MONITOR_PRIVATE_DIR || join(ROOT, '.local', 'monitor-private'));

let passed = 0;
let failed = 0;
const check = (name, ok, details = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details ? ` — ${details}` : ''}`);
};

// Свежая сессия: проверка входа идёт тем же путём, что и мониторинг.
execFileSync(process.execPath, [join(ROOT, 'scripts', 'monitor-app-probe.mjs')], {
  stdio: 'ignore',
});
const cookie = readFileSync(join(privateDir, 'app-probe-session'), 'utf8').trim();
const csrf = (cookie.match(/ul_csrf=([^;]+)/) || [])[1] ?? '';
const call = async (method, path, body) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  let text = '';
  try {
    text = JSON.stringify(await r.json());
  } catch {
    /* не JSON */
  }
  return { status: r.status, monitoringStage: text.includes('Служебная учётка мониторинга') };
};

const pool = new pg.Pool({ connectionString: env.DATABASE_URL_OWNER, max: 2 });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
try {
  const expected = JSON.parse(
    readFileSync(
      join(
        resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state')),
        'app-probe-expected.json',
      ),
      'utf8',
    ),
  );
  const view = await call('GET', `/v1/projects/${expected.projectId}/investor-view`);
  check('контрольное чтение карточки — разрешено', view.status === 200, view.status);
  const file = await call(
    'GET',
    `/v1/projects/${expected.projectId}/materials/${expected.materialId}/content`,
  );
  check('контрольное чтение файла — разрешено', file.status === 200, file.status);

  for (const [name, method, path, body] of [
    ['изменение своего профиля', 'PATCH', '/v1/me/profile', { displayName: 'опыт W08a' }],
    ['загрузка аватара (форма)', 'POST', '/v1/me/avatar/upload', {}],
    ['удаление аватара', 'DELETE', '/v1/me/avatar'],
    ['чтение своего профиля', 'GET', '/v1/me/profile'],
    ['создание проекта', 'POST', '/v1/projects', { title: 'опыт' }],
  ]) {
    const r = await call(method, path, body);
    check(`${name} — отказ ограничением учётки`, r.status === 403 && r.monitoringStage, r.status);
  }

  const [probe] = await q(
    `SELECT id FROM identity.users WHERE origin = 'monitoring' AND primary_role = 'investor'`,
  );
  const [other] = await q(
    `SELECT p.id, fp.user_id FROM lab.projects p
       JOIN lab.founders_projects fp ON fp.project_id = p.id
      WHERE p.origin <> 'monitoring' AND p.deleted_at IS NULL LIMIT 1`,
  );
  const [grant] = await q(
    `INSERT INTO lab.project_access_grants (id, project_id, grantee_user_id, permissions, granted_by, reason)
     VALUES (public.uuid_generate_v7(), $1, $2, ARRAY['profile','materials'], $3,
             'проверка check-monitoring-account: ошибочно выданное разрешение, отзывается сразу')
     RETURNING id`,
    [other.id, probe.id, other.user_id],
  );
  try {
    const r = await call('GET', `/v1/projects/${other.id}/investor-view`);
    check(
      'обычный проект С выданным разрешением — отказ',
      r.status === 403 && r.monitoringStage,
      r.status,
    );
  } finally {
    await q(`UPDATE lab.project_access_grants SET revoked_at = now() WHERE id = $1`, [grant.id]);
  }

  const me = await call('GET', '/v1/auth/me');
  check('«кто я» — разрешено', me.status === 200, me.status);
} finally {
  await pool.end();
}
console.log(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
