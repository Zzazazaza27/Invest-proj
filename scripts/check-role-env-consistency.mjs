#!/usr/bin/env node
// Гейт самосогласованности логин-ролей БД (Ф32, CODE-HIGH-01 / SEC-MED-06).
//
// История: Ф31 добавила роль app_archive в bootstrap-roles.ts и в
// check-service-roles.mjs, но CI-workflow не получил ни пароль, ни URL —
// джоба БД была обречена падать, а негативные проверки новой роли фактически
// не запускались. Этот гейт делает расхождение видимым в момент коммита:
// каждая роль из bootstrap обязана иметь пароль в CI и в .env.example,
// каждый urlKey из гейта границ ролей обязан экспортироваться в CI.
//
// Ф58 показала второй класс той же болезни: DATABASE_URL_APP_AUTH была в CI,
// но не в .env.example, а DATABASE_URL примера указывала на групповую роль
// app_backend без LOGIN. Гейт сверял с примером только пароли — обе пропажи
// прожили до развёртывания с нуля. Теперь urlKey и имена ролей внутри URL
// сверяются и с .env.example.
//
// Статический: читает исходники, к БД не подключается. Путь к workflow можно
// передать первым аргументом, путь к .env.example — вторым: так гейт
// проверяется на падение против исторической версии файла.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const ciPath = process.argv[2] ?? resolve(root, '.github/workflows/ci.yml');
const envExamplePath = process.argv[3] ?? resolve(root, '.env.example');

const bootstrapSrc = readFileSync(resolve(root, 'database/src/bootstrap-roles.ts'), 'utf8');
const rolesGateSrc = readFileSync(resolve(root, 'scripts/check-service-roles.mjs'), 'utf8');
const envExample = readFileSync(envExamplePath, 'utf8');
const ci = readFileSync(ciPath, 'utf8');

const passwordEnvs = [...bootstrapSrc.matchAll(/passwordEnv:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);
const urlKeys = [...rolesGateSrc.matchAll(/urlKey:\s*'([A-Z0-9_]+)'/g)].map((m) => m[1]);

if (passwordEnvs.length === 0 || urlKeys.length === 0) {
  console.error('гейт не нашёл ни одной роли — сломан разбор исходников, это провал гейта');
  process.exit(1);
}

const failures = [];
const ok = (label) => console.warn(`  ok  ${label}`);
const fail = (label, why) => {
  failures.push(`${label}: ${why}`);
  console.error(`  ПРОВАЛ  ${label}: ${why}`);
};

console.warn(
  `\n=== СОГЛАСОВАННОСТЬ РОЛЕЙ БД (bootstrap ${passwordEnvs.length}, urlKey ${urlKeys.length}) ===\n`,
);

for (const name of passwordEnvs) {
  if (new RegExp(`^\\s+${name}:`, 'm').test(ci)) ok(`CI задаёт ${name}`);
  else fail(`CI задаёт ${name}`, 'переменной нет в workflow — bootstrap ролей упадёт');
  if (new RegExp(`^${name}=`, 'm').test(envExample)) ok(`.env.example содержит ${name}`);
  else fail(`.env.example содержит ${name}`, 'разработчик не узнает о новой роли');
}

// Пары urlKey → логин-роль из гейта границ: в объявлении роли поля идут
// подряд (role, urlKey, login), поэтому пару даёт один matchAll.
const urlKeyLogins = new Map(
  [...rolesGateSrc.matchAll(/urlKey:\s*'([A-Z0-9_]+)',\s*\n\s*login:\s*'([a-z0-9_]+)'/g)].map(
    (m) => [m[1], m[2]],
  ),
);
// Имя роли внутри значения KEY=postgres://<роль>:...
const envUrlRole = (key) => envExample.match(new RegExp(`^${key}=postgres://([^:@/]+)[:@]`, 'm'))?.[1];

for (const key of urlKeys) {
  if (new RegExp(`export ${key}=`).test(ci)) ok(`CI экспортирует ${key}`);
  else fail(`CI экспортирует ${key}`, 'гейт границ ролей не получит подключение');

  const role = envUrlRole(key);
  if (role === undefined) {
    fail(`.env.example содержит ${key}`, 'без неё контур молча недоступен на чистом стенде (Ф58)');
    continue;
  }
  const expected = urlKeyLogins.get(key);
  if (expected === undefined || role === expected) ok(`.env.example: ${key} → ${role}`);
  else fail(`.env.example: ${key} → ${role}`, `гейт границ ролей ждёт логин-роль ${expected}`);
}

// DATABASE_URL основного API не входит в urlKeys, но Ф58 споткнулась именно о
// него: пример указывал на групповую роль app_backend без LOGIN. Роль в URL
// обязана быть логин-ролью из bootstrap, а не именем группы.
const bootstrapLogins = [...bootstrapSrc.matchAll(/login:\s*'([a-z0-9_]+)'/g)].map((m) => m[1]);
const mainRole = envUrlRole('DATABASE_URL');
if (mainRole === undefined) {
  fail('.env.example содержит DATABASE_URL', 'без него ядро не стартует');
} else if (bootstrapLogins.includes(mainRole)) {
  ok(`.env.example: DATABASE_URL → ${mainRole}`);
} else {
  fail(
    `.env.example: DATABASE_URL → ${mainRole}`,
    'bootstrap такой логин-роли не заводит — вероятно, это групповая роль без LOGIN (Ф58)',
  );
}

// Обратное направление: пароль в CI без роли в bootstrap — мёртвая переменная,
// чаще всего след удалённой роли, которую забыли убрать из workflow.
const ciPasswordEnvs = [...ci.matchAll(/^\s+(DB_ROLE_PASSWORD_[A-Z0-9_]+):/gm)].map((m) => m[1]);
for (const name of new Set(ciPasswordEnvs)) {
  if (passwordEnvs.includes(name)) continue;
  fail(`CI-переменная ${name} известна bootstrap`, 'в bootstrap-roles.ts такой роли нет');
}

if (failures.length > 0) {
  console.error(
    `\nИтог: ${failures.length} расхождений. Списки ролей разошлись между bootstrap, CI и .env.example.`,
  );
  process.exit(1);
}
console.warn('\nИтог: расхождений нет.');
