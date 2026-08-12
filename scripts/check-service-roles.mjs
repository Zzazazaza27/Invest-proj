#!/usr/bin/env node
/**
 * Проверка сервисных подключений БД.
 *
 * Настроенная переменная окружения и работающее подключение — разные
 * утверждения. Здесь проверяется второе: под каждой сервисной ролью
 * открывается соединение, подтверждается фактическое имя роли и проверяется
 * граница прав — то, что роли РАЗРЕШЕНО, и то, что ей ЗАПРЕЩЕНО.
 *
 * Проверка запрета важнее проверки доступа: роль, которая «работает», но при
 * этом читает чужой контур, хуже неработающей — она выглядит настроенной.
 *
 * Запуск: node scripts/check-service-roles.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const env = { ...process.env };
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.warn(`  OK   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Запрос должен УПАСТЬ: проверяем границу прав, а не доступ. */
async function mustFail(client, name, sql) {
  try {
    await client.query(sql);
    check(name, false, 'запрос прошёл, хотя роли это запрещено');
  } catch (error) {
    const code = error.code ?? '?';
    // 42P01 (нет такой таблицы) НЕ считается отказом в доступе: проверка,
    // указывающая на несуществующий объект, зеленела бы, ничего не проверяя.
    if (code === '42P01') {
      check(name, false, 'объекта не существует — проверка ничего не доказывает');
      return;
    }
    check(name, code === '42501' || code === '3F000', `отказ ${code}`);
  }
}

const ROLES = [
  {
    role: 'app_billing',
    urlKey: 'DATABASE_URL_APP_BILLING',
    login: 'app_billing_user',
    allowed: [
      ['читает начисления', 'SELECT count(*) FROM billing.commission_accruals'],
      ['читает счета', 'SELECT count(*) FROM billing.invoices'],
    ],
    // Плательщика и договор биллинг читать обязан — без них не выставить счёт
    // (политики users_system_read и agreements_billing_read, M002/M005).
    // Границей является другое: персональные данные проверки личности и
    // содержимое заявок к деньгам отношения не имеют.
    forbidden: [
      ['не читает проверки личности', 'SELECT count(*) FROM kyc.kyc_verifications'],
      ['не читает материалы проектов', 'SELECT count(*) FROM lab.project_materials'],
    ],
  },
  {
    role: 'app_notifications',
    urlKey: 'DATABASE_URL_APP_NOTIFICATIONS',
    login: 'app_notifications_user',
    allowed: [
      ['читает шаблоны', 'SELECT count(*) FROM comms.notification_templates'],
      ['читает очередь уведомлений', 'SELECT count(*) FROM comms.notifications'],
    ],
    forbidden: [
      ['не читает проекты', 'SELECT count(*) FROM lab.projects'],
      ['не читает деньги', 'SELECT count(*) FROM billing.invoices'],
    ],
  },
  {
    // Плановое обслуживание (M039). Роль знает только о мусоре, который убирает:
    // ни проектов, ни персональных данных, ни денег.
    role: 'app_maintenance',
    urlKey: 'DATABASE_URL_APP_MAINTENANCE',
    login: 'app_maintenance_user',
    allowed: [
      ['читает реестр отозванных токенов', 'SELECT count(*) FROM identity.revoked_tokens'],
      ['читает брошенные билеты на загрузку', 'SELECT count(*) FROM lab.project_materials'],
    ],
    forbidden: [
      ['не читает проекты', 'SELECT count(*) FROM lab.projects'],
      ['не читает пользователей', 'SELECT count(*) FROM identity.users'],
      ['не читает деньги', 'SELECT count(*) FROM billing.invoices'],
    ],
  },
  {
    role: 'app_integration',
    urlKey: 'DATABASE_URL_APP_INTEGRATION',
    login: 'app_integration_user',
    allowed: [
      ['читает проекцию вознаграждения', 'SELECT count(*) FROM integration.deal_commissions'],
    ],
    forbidden: [
      ['не читает начисления биллинга', 'SELECT count(*) FROM billing.commission_accruals'],
      ['не читает identity.users', 'SELECT count(*) FROM identity.users'],
    ],
  },
];

console.warn('\n=== СЕРВИСНЫЕ ПОДКЛЮЧЕНИЯ БД ===\n');

for (const spec of ROLES) {
  const url = env[spec.urlKey];
  console.warn(`--- ${spec.role} ---`);
  if (!url) {
    check(`${spec.urlKey} задан`, false, 'переменная пуста');
    continue;
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    // Логин-пользователь входит в систему как `*_user`, но работает под
    // ГРУППОВОЙ ролью: `ALTER ROLE ... SET role` (bootstrap-roles). Проверяются
    // оба факта — иначе незамеченная потеря SET role оставила бы соединение с
    // правами логин-пользователя, у которого их нет вовсе.
    const { rows } = await client.query('SELECT current_user AS effective, session_user AS login');
    check(
      `подключение ${spec.login} → роль ${spec.role}`,
      rows[0].login === spec.login && rows[0].effective === spec.role,
      `session_user=${rows[0].login}, current_user=${rows[0].effective}`,
    );

    for (const [name, sql] of spec.allowed) {
      try {
        await client.query(sql);
        check(name, true);
      } catch (error) {
        check(name, false, `${error.code ?? ''} ${error.message}`.slice(0, 90));
      }
    }
    for (const [name, sql] of spec.forbidden) {
      await mustFail(client, name, sql);
    }
  } catch (error) {
    check(`подключение ${spec.role}`, false, error.message.slice(0, 90));
  } finally {
    await client.end().catch(() => {});
  }
}

console.warn(`\n=== ИТОГ: ${passed} проверок пройдено, ${failed} провалено ===\n`);
process.exit(failed > 0 ? 1 : 0);
