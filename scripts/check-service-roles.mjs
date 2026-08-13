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
async function mustFail(client, name, sql, expectedCodes = ['42501', '3F000']) {
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
    // Тип ошибки проверяется, а не только её факт: отказ по другой причине —
    // это зелёный по неверной причине (RULES.md §4).
    check(name, expectedCodes.includes(code), `отказ ${code}`);
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
    // Состояние сессий (M046). Роль знает ровно то, что нужно проверке входа:
    // рубеж и реестр отозванных токенов. Ни паролей, ни контактов, ни ролей —
    // права на `identity.users` выданы ПОКОЛОНОЧНО, поэтому запрос к любой
    // другой колонке этой же таблицы отвергается (SEC-21).
    role: 'app_auth',
    urlKey: 'DATABASE_URL_APP_AUTH',
    login: 'app_auth_user',
    allowed: [
      [
        'читает рубеж сессий',
        'SELECT count(*) FROM (SELECT id, sessions_valid_from FROM identity.users) t',
      ],
      ['читает реестр отозванных токенов', 'SELECT count(*) FROM identity.revoked_tokens'],
    ],
    forbidden: [
      ['не читает пароли', 'SELECT password_hash FROM identity.users LIMIT 1'],
      ['не читает контакты', 'SELECT email_hmac FROM identity.users LIMIT 1'],
      ['не читает роли', 'SELECT count(*) FROM identity.user_roles'],
      ['не читает проекты', 'SELECT count(*) FROM lab.projects'],
      ['не удаляет отзывы', "DELETE FROM identity.revoked_tokens WHERE jti = 'нет'"],
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
  {
    // Выгрузка журнала в архив (M052, остаток SEC-10). Роль читает журнал
    // ЦЕЛИКОМ (это её назначение) и ведёт append-only реестр выгрузок.
    // Изменять журнал и реестр, а также заглядывать в данные приложений — нет.
    role: 'app_archive',
    urlKey: 'DATABASE_URL_APP_ARCHIVE',
    login: 'app_archive_user',
    allowed: [
      ['читает журнал целиком', 'SELECT count(*) FROM audit.events'],
      ['читает реестр выгрузок', 'SELECT count(*) FROM audit.event_archives'],
      ['сверяет hash-chain', 'SELECT count(*) FROM audit.verify_event_chain(NULL)'],
      [
        'сверяет hash-chain диапазона (M053)',
        'SELECT count(*) FROM audit.verify_event_chain_range(NULL, now())',
      ],
    ],
    forbidden: [
      ['не пишет в журнал', "INSERT INTO audit.events (verb) VALUES ('x')"],
      ['не правит журнал', "UPDATE audit.events SET verb = 'x' WHERE false"],
      ['не удаляет из журнала', 'DELETE FROM audit.events WHERE false'],
      [
        // M053: прямой INSERT отозван — единственный путь в реестр лежит через
        // append-функцию с инвариантами непрерывности (CODE-HIGH-10).
        'не вставляет в реестр напрямую',
        `INSERT INTO audit.event_archives
           (period_start, period_end, object_key, event_count, sha256, chain_intact)
         VALUES (now() - interval '1 day', now() + interval '365 days',
                 'archive/audit-events/poison', 0, repeat('0', 64), true)`,
      ],
      [
        // P0001 — RAISE EXCEPTION самой функции: отравление отвергнуто
        // инвариантом, а не правами.
        'append-функция отвергает границу в будущем',
        `SELECT audit.append_event_archive(
           (SELECT coalesce(max(period_end), to_timestamp(0)) FROM audit.event_archives),
           now() + interval '365 days',
           'archive/audit-events/poison-future', 1, repeat('0', 64), NULL, NULL, true)`,
        ['P0001'],
      ],
      [
        'не правит реестр выгрузок',
        "UPDATE audit.event_archives SET sha256 = repeat('0', 64) WHERE false",
      ],
      ['не удаляет из реестра', 'DELETE FROM audit.event_archives WHERE false'],
      ['не читает пользователей', 'SELECT count(*) FROM identity.users'],
      ['не читает проекты', 'SELECT count(*) FROM lab.projects'],
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
    for (const [name, sql, codes] of spec.forbidden) {
      await mustFail(client, name, sql, codes);
    }
  } catch (error) {
    check(`подключение ${spec.role}`, false, error.message.slice(0, 90));
  } finally {
    await client.end().catch(() => {});
  }
}

console.warn(`\n=== ИТОГ: ${passed} проверок пройдено, ${failed} провалено ===\n`);
process.exit(failed > 0 ? 1 : 0);
