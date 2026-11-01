#!/usr/bin/env node
/**
 * Разрешённое чтение контрольных данных прикладным путём (требование 2.5;
 * блок 8, 8.2; 2.1-W08a — замечание Тэнка при приёмке).
 *
 * Служебная учётка мониторинга (`monitor-probe-init.mjs`) входит обычным
 * входом через ПУБЛИЧНЫЙ адрес и читает контрольный проект и его материал
 * обычными маршрутами — через авторизацию, RLS и выданное разрешение:
 *   1. GET /v1/projects/:id/investor-view — проект виден, материал в списке;
 *   2. GET /v1/projects/:id/materials/:mid/content — файл, сверка размера и SHA-256.
 * Поломка входа, проверки прав или выдачи файла — провал, даже если
 * инфраструктура исправна (её проверяет `/control` на служебном порту).
 *
 * Сессия переиспользуется: вход — только при 401, не каждую минуту. Cookie
 * хранится в MONITOR_PRIVATE_DIR (агенту Zabbix не виден), итог — без
 * секретов — в MONITOR_STATE_DIR/app-probe.json для агента.
 *
 *   node scripts/monitor-app-probe.mjs        один раз (таймер узла — раз в минуту)
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, loadEnv } from './lib/backup.mjs';

loadEnv();
const env = process.env;
const BASE = (env.MONITOR_PUBLIC_URL || 'http://127.0.0.1').replace(/\/$/, '');
const stateDir = resolve(env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
const privateDir = resolve(env.MONITOR_PRIVATE_DIR || join(ROOT, '.local', 'monitor-private'));
mkdirSync(privateDir, { recursive: true });
const sessionFile = join(privateDir, 'app-probe-session');
const expected = JSON.parse(readFileSync(join(stateDir, 'app-probe-expected.json'), 'utf8'));
const started = Date.now();

let cookie = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf8').trim() : '';
const call = (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    redirect: 'manual',
    headers: { ...(init.headers ?? {}), ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(15_000),
  });

async function login() {
  const r = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: expected.email, password: env.CONTROL_PROBE_PASSWORD }),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`вход служебной учётки: ${r.status}`);
  cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  writeFileSync(sessionFile, cookie);
  chmodSync(sessionFile, 0o600);
}

/** Запрос с повторным входом при 401 (истёкшая или отозванная сессия). */
async function authed(path) {
  let r = await call(path);
  if (r.status === 401) {
    await login();
    r = await call(path);
  }
  return r;
}

async function probe() {
  const view = await authed(`/v1/projects/${expected.projectId}/investor-view`);
  if (view.status !== 200)
    return { ok: false, step: 'project', reason: `карточка проекта: HTTP ${view.status}` };
  const body = await view.json();
  const text = JSON.stringify(body);
  if (!text.includes(expected.title))
    return { ok: false, step: 'project', reason: 'карточка без контрольного названия' };
  if (!text.includes(expected.materialId)) {
    return { ok: false, step: 'project', reason: 'контрольный материал не виден по разрешению' };
  }
  const file = await authed(
    `/v1/projects/${expected.projectId}/materials/${expected.materialId}/content`,
  );
  if (file.status !== 200)
    return { ok: false, step: 'file', reason: `контрольный файл: HTTP ${file.status}` };
  const bytes = Buffer.from(await file.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== expected.sizeBytes || sha !== expected.sha256) {
    return { ok: false, step: 'file', reason: 'содержимое контрольного файла не совпало' };
  }
  return { ok: true, step: 'done', reason: 'разрешённое чтение проекта и файла прошло' };
}

let result;
try {
  result = await probe();
} catch (error) {
  result = { ok: false, step: 'error', reason: String(error.message ?? error).slice(0, 200) };
}
const out = { at: new Date().toISOString(), ms: Date.now() - started, ...result };
mkdirSync(stateDir, { recursive: true });
const target = join(stateDir, 'app-probe.json');
writeFileSync(`${target}.tmp`, JSON.stringify(out, null, 2));
renameSync(`${target}.tmp`, target);
console.log(`${out.ok ? 'ok' : 'ПРОВАЛ'} (${out.ms} мс): ${out.reason}`);
process.exit(out.ok ? 0 : 1);
