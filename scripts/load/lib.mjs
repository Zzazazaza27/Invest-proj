/**
 * Общее для подготовки и запуска нагрузочного прогона (W32, профиль p1).
 *
 * Цель — адрес платформы `FIFTH_LOAD_BASE` (по умолчанию локальный стенд
 * http://127.0.0.1). test-1 закрыт паролем Caddy: тогда `FIFTH_LOAD_BASIC_AUTH_FILE`
 * — файл с одной строкой `user:password`. Значение нигде не печатается и уходит
 * только на адрес цели, не в хранилище.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASE = (process.env.FIFTH_LOAD_BASE ?? 'http://127.0.0.1').replace(/\/+$/, '');

/** Локальный ли адрес цели: от этого зависят пароль из `.env` и адрес для Docker. */
export function isLocalBase(base = BASE) {
  const host = new URL(base).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/** Значение `Authorization: Basic …` из файла, либо null. Само значение не печатается. */
export function basicAuthHeader() {
  const file = process.env.FIFTH_LOAD_BASIC_AUTH_FILE;
  if (!file) return null;
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw.includes(':'))
    throw new Error('FIFTH_LOAD_BASIC_AUTH_FILE: ожидается строка user:password');
  return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
}

/** Значение переменной из корневого `.env` (не печатается). */
export function dotEnvValue(key) {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return null;
  const m = readFileSync(file, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m?.[1] ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * Клиент с собственной банкой cookie и CSRF, как в check-upload-publish-right.
 *
 * На 429 ждёт `Retry-After` и повторяет: подготовка данных идёт через те же
 * ограничения частоты, что и пользователи, и не должна падать на них.
 */
export function client({ extraHeaders = {} } = {}) {
  const jar = new Map();
  const auth = basicAuthHeader();
  async function call(path, { method = 'GET', body, key = false, headers: more = {} } = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const headers = { 'X-Fifth-Origin': 'render_check', ...extraHeaders, ...more };
      if (auth) headers.Authorization = auth;
      if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const csrf = [...jar].find(([k]) => /csrf/i.test(k))?.[1];
      if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
      if (key) headers['Idempotency-Key'] = randomUUID();
      const r = await fetch(`${BASE}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      for (const cookie of r.headers.getSetCookie?.() ?? []) {
        const [pair] = cookie.split(';');
        const eq = pair.indexOf('=');
        jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      const text = await r.text();
      if (r.status === 429 && attempt < 6) {
        const wait = Math.min(Number(r.headers.get('retry-after')) || 10, 65);
        console.log(`  … 429 на ${method} ${path.replace(/[0-9a-f-]{36}/g, ':id')}, жду ${wait} с`);
        await sleep(wait * 1000);
        continue;
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* не JSON */
      }
      return { status: r.status, json, text };
    }
  }
  return { call };
}

/** Пароль администратора: файл (для удалённой цели) или `.env` (только локальный стенд). */
export function adminPassword() {
  const file = process.env.FIFTH_LOAD_ADMIN_PASSWORD_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  if (isLocalBase()) {
    const local = dotEnvValue('DEMO_USER_PASSWORD') ?? dotEnvValue('DEV_TEST_USER_PASSWORD');
    if (local) return local;
  }
  throw new Error('нет пароля администратора: задай FIFTH_LOAD_ADMIN_PASSWORD_FILE');
}

export const ADMIN_EMAIL = process.env.FIFTH_LOAD_ADMIN_EMAIL ?? 'demo-admin@fifth.local';

export async function adminLogin() {
  const admin = client();
  const r = await admin.call('/v1/auth/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: adminPassword() },
  });
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`вход администратора: HTTP ${r.status}`);
  return admin;
}

/** Каталог данных прогона (вне Git: `.local/` в .gitignore). */
export function runDir(runId) {
  if (!/^[a-z0-9-]{4,40}$/.test(runId)) throw new Error(`недопустимый run_id: ${runId}`);
  return join(ROOT, '.local', 'load', runId);
}

/** Разбор `--ключ значение` и позиционных аргументов. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[name] = true;
      else {
        out[name] = next;
        i += 1;
      }
    } else out._.push(a);
  }
  return out;
}
