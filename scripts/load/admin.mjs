#!/usr/bin/env node
/**
 * Учётная запись администратора цели для подготовки данных нагрузки (W32).
 *
 *   FIFTH_LOAD_BASE=https://test-1.5espace.com FIFTH_LOAD_BASIC_AUTH_FILE=.local/load/test-1-basic.txt \
 *     node scripts/load/admin.mjs register
 *
 * Регистрирует участника через API цели с паролем, сгенерированным здесь, и пишет
 * `.local/load/<хост>-admin.json` (почта, пароль, id) — вне Git; значения не печатаются.
 * Права (admin и testing.sessions.manage) выдаёт шаг на сервере
 * `fifth-test op prod-test1-load-admin grant <id>`. Повторный запуск берёт сохранённое.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, ROOT, client } from './lib.mjs';

const host = new URL(BASE).hostname;
const file = join(ROOT, '.local', 'load', `${host}-admin.json`);
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

if (process.argv[2] !== 'register') {
  console.error('команда: register');
  process.exit(2);
}
mkdirSync(join(ROOT, '.local', 'load'), { recursive: true });
const saved = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const account = saved ?? {
  email: `load-admin-${randomBytes(4).toString('hex')}@test.local`,
  password: `Ld-${randomBytes(18).toString('base64url')}`,
  id: null,
};
const c = client();
if (!saved) {
  const r = await c.call('/v1/auth/register', {
    method: 'POST',
    body: {
      email: account.email,
      password: account.password,
      displayName: 'Нагрузка — администратор',
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    },
  });
  if (r.status >= 300) {
    console.error(`регистрация: HTTP ${r.status} ${r.json?.code ?? ''}`);
    process.exit(1);
  }
}
const login = await c.call('/v1/auth/login', {
  method: 'POST',
  body: { email: account.email, password: account.password },
});
if (login.status !== 200 && login.status !== 201) {
  console.error(`вход: HTTP ${login.status} ${login.json?.code ?? ''}`);
  process.exit(1);
}
account.id = (await c.call('/v1/auth/me')).json?.id ?? account.id;
writeFileSync(file, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ ok: true, host, id: account.id, file }));
