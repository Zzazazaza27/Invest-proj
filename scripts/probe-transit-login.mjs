#!/usr/bin/env node
/**
 * Настоящий вход в среде с искусственными ключами (блок 5, задание 5, проба test-1).
 *
 *   node scripts/probe-transit-login.mjs register <файл-учёток> <метка>
 *   node scripts/probe-transit-login.mjs login    <файл-учёток>
 *
 * Адрес — PROBE_URL. `register` заводит учётку через обычный маршрут, `login` входит под каждой
 * заведённой и читает маску контакта. Пароли случайные и лежат в файле пробы, значения не печатаются.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const BASE = process.env.PROBE_URL;
const PREFIX = process.env.PROBE_COOKIE_PREFIX ?? '';
const [command, file, label] = process.argv.slice(2);
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function client() {
  const jar = new Map();
  const call = async (path, { method = 'GET', body } = {}) => {
    const csrf = jar.get(`${PREFIX}ul_csrf`);
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(csrf && method !== 'GET' ? { 'X-CSRF-Token': csrf } : {}),
        ...(process.env.PROBE_ORIGIN ? { Origin: process.env.PROBE_ORIGIN } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    const text = await response.text();
    return { status: response.status, json: parsed(text) };
  };
  call.session = () => jar.get(`${PREFIX}ul_session`) ?? '';
  return call;
}

const accounts = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
let failed = false;

if (command === 'register') {
  const email = `probe-${label}-${Date.now() % 1e9}@test.invalid`;
  const password = `Pw-${randomUUID()}`;
  const r = await client()('/v1/auth/register', {
    method: 'POST',
    body: {
      email,
      password,
      displayName: 'Проба ключей',
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  failed = r.status >= 400;
  console.log(`регистрация ${label}: код ${r.status}`);
  if (!failed) {
    accounts.push({ label, email, password });
    writeFileSync(file, JSON.stringify(accounts), { mode: 0o600 });
  }
} else if (command === 'login') {
  for (const { label: name, email, password } of accounts) {
    const call = client();
    const login = await call('/v1/auth/login', { method: 'POST', body: { email, password } });
    const me = await call('/v1/auth/me');
    const masked = typeof me.json?.emailMasked === 'string' && !me.json.emailMasked.includes(email);
    const kid = process.env.PROBE_EXPECT_KID;
    const signed = !kid || call.session().startsWith(`${kid}.`);
    const ok = login.status < 300 && me.status === 200 && masked && signed;
    if (!ok) failed = true;
    console.log(
      `вход ${name}: код ${login.status}, контакт ${masked ? 'читается' : 'НЕ читается'}`,
    );
  }
  if (accounts.length === 0) failed = true;
} else if (command === 'down') {
  // Отказ службы ключей: именно отказ зависимости, а не неверный пароль.
  const { email, password } = accounts[0];
  const r = await client()('/v1/auth/login', { method: 'POST', body: { email, password } });
  const dependency = r.status === 503 && JSON.stringify(r.json).includes('dependency');
  console.log(
    `вход без OpenBao: код ${r.status}, ${dependency ? 'отказ зависимости' : 'другая причина'}`,
  );
  failed = !dependency;
} else {
  console.error('команды: register, login, down');
  failed = true;
}
process.exit(failed ? 1 : 0);
