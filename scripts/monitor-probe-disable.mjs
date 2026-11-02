#!/usr/bin/env node
/**
 * Безопасное прекращение работы служебной учётки мониторинга (пара к
 * monitor-probe-init.mjs; замечание Тэнка 2026-11-02 к плану выпуска W08a).
 *
 * Применяется при откате кода W08a и при сбое шага «служебная учётка и
 * контрольный проект». Ничего не удаляет: учётка, проект и файл остаются
 * для диагностики.
 *
 * Порядок:
 *   1. проба остановлена — таймер fifth-monitor-app-probe не активен (иначе
 *      отказ: проба снова войдёт сама);
 *   2. учётка заблокирована (status = suspended) и рубеж сессий сдвинут
 *      (sessions_valid_from) — живые токены перестают действовать, как при
 *      блокировке из админки;
 *   3. проверка отказа — только ожидаемые ответы (scripts/lib/monitor-probe.mjs):
 *      сохранённой сессией `GET /v1/auth/me` → 401 unauthenticated (рубеж в
 *      ядре кешируется до 5 с — ждём до 20 с); вход паролем пробы → 403
 *      forbidden при статусе в базе suspended. 429, 503, 404 и прочее — НЕ
 *      подтверждение: скрипт завершается отказом, откат кода дальше не идёт;
 *   4. сохранённая сессия пробы удалена.
 *
 *   node scripts/monitor-probe-disable.mjs
 *
 * Возврат в работу — `monitor-probe-init.mjs` (снова делает учётку active).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { ROOT, loadEnv } from './lib/backup.mjs';
import { pinnedFetch } from './lib/pinned-fetch.mjs';
import { loginDenialVerdict, sessionDenialVerdict } from './lib/monitor-probe.mjs';

loadEnv();
const env = process.env;
const BASE = (env.MONITOR_PUBLIC_URL || 'http://127.0.0.1').replace(/\/$/, '');
const stateDir = resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
const privateDir = resolve(env.MONITOR_PRIVATE_DIR || join(ROOT, '.local', 'monitor-private'));
const sessionFile = join(privateDir, 'app-probe-session');
const expected = JSON.parse(readFileSync(join(stateDir, 'app-probe-expected.json'), 'utf8'));
const fail = (msg) => {
  console.error(`ОТКАЗ: ${msg}`);
  process.exit(1);
};

// 1. Проба должна быть остановлена (на машине без systemd шаг пропускается).
let timer;
try {
  timer = execFileSync('systemctl', ['is-active', 'fifth-monitor-app-probe.timer'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch (e) {
  timer = `${e.stdout || ''}`.trim() || 'нет systemd';
}
if (timer === 'active')
  fail(
    'таймер fifth-monitor-app-probe активен — сначала: systemctl disable --now fifth-monitor-app-probe.timer',
  );
console.log(`1. проба: таймер — ${timer}`);

// 2. Блокировка и сдвиг рубежа сессий.
const pool = new pg.Pool({ connectionString: env.DATABASE_URL_OWNER, max: 1 });
const users = (
  await pool.query(
    `SELECT id, status FROM identity.users WHERE origin = 'monitoring' AND primary_role = 'investor'`,
  )
).rows;
if (users.length !== 1) {
  await pool.end();
  fail(`учётка мониторинга не найдена однозначно (найдено ${users.length})`);
}
const [user] = users;
await pool.query(
  `UPDATE identity.users
      SET status = 'suspended',
          status_reason = 'мониторинг выключен: monitor-probe-disable.mjs',
          status_changed_at = now(), updated_at = now(),
          sessions_valid_from = date_trunc('second', now()) + interval '1 second'
    WHERE id = $1`,
  [user.id],
);
console.log(`2. учётка заблокирована (было: ${user.status}), рубеж сессий сдвинут`);

// 3. Проверка отказа — только ожидаемые ответы.
const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const cookie = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim() : '';
if (cookie) {
  const end = Date.now() + 20_000;
  let verdict;
  while (Date.now() < end) {
    const res = await pinnedFetch(`${BASE}/v1/auth/me`, {
      headers: { cookie },
      signal: AbortSignal.timeout(10_000),
    });
    verdict = sessionDenialVerdict(res.status, await json(res));
    if (verdict.ok) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!verdict.ok) {
    await pool.end();
    fail(`отзыв сессий НЕ подтверждён — ${verdict.reason}`);
  }
  console.log(`3. ${verdict.reason}`);
} else {
  console.log('3. сохранённой сессии пробы нет — проверка сессии не требуется');
}
const login = await pinnedFetch(`${BASE}/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: expected.email, password: env.CONTROL_PROBE_PASSWORD }),
  signal: AbortSignal.timeout(10_000),
});
const loginBody = await json(login);
const [{ status: dbStatus }] = (
  await pool.query(`SELECT status FROM identity.users WHERE id = $1`, [user.id])
).rows;
await pool.end();
const loginVerdict = loginDenialVerdict(login.status, loginBody, dbStatus);
if (!loginVerdict.ok) fail(`запрет входа НЕ подтверждён — ${loginVerdict.reason}`);
console.log(`3. ${loginVerdict.reason}`);

// 4. Сохранённая сессия больше не нужна.
rmSync(sessionFile, { force: true });
console.log('4. сохранённая сессия пробы удалена; учётка, проект и файл оставлены для диагностики');
