/**
 * Создание логин-пользователей БД из переменных окружения.
 *
 * Групповые роли (app_backend, app_billing, …) создаёт миграция M000 как
 * NOLOGIN — паролей в миграциях нет и быть не должно. Этот скрипт заводит
 * логин-пользователей и включает их в соответствующие группы.
 *
 * Пароль НЕ передаётся на сервер в открытом виде: клиент сам считает
 * SCRAM-SHA-256 верификатор и отправляет уже его. Иначе пароль сервисной роли
 * оказался бы в журнале запросов PostgreSQL при включённом log_statement.
 *
 * Запуск: npm run bootstrap:roles -w database
 */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import pg from 'pg';
import { ownerConnectionString, requireEnv, sslConfig } from './env.ts';

const ROLE_MAP: { login: string; group: string; passwordEnv: string }[] = [
  { login: 'app_backend_user', group: 'app_backend', passwordEnv: 'DB_ROLE_PASSWORD_APP_BACKEND' },
  {
    login: 'app_public_read_user',
    group: 'app_public_read',
    passwordEnv: 'DB_ROLE_PASSWORD_APP_PUBLIC_READ',
  },
  {
    login: 'app_investments_user',
    group: 'app_investments',
    passwordEnv: 'DB_ROLE_PASSWORD_APP_INVESTMENTS',
  },
  { login: 'app_billing_user', group: 'app_billing', passwordEnv: 'DB_ROLE_PASSWORD_APP_BILLING' },
  {
    login: 'app_notifications_user',
    group: 'app_notifications',
    passwordEnv: 'DB_ROLE_PASSWORD_APP_NOTIFICATIONS',
  },
  {
    login: 'app_integration_user',
    group: 'app_integration',
    passwordEnv: 'DB_ROLE_PASSWORD_APP_INTEGRATION',
  },
  {
    login: 'app_readonly_user',
    group: 'app_readonly',
    passwordEnv: 'DB_ROLE_PASSWORD_APP_READONLY',
  },
  // Плановое обслуживание: уборка реестра отозванных токенов и брошенных
  // билетов на загрузку. Отдельная роль, а не «та, у которой подошли права»
  // (M039).
  {
    login: 'app_maintenance_user',
    group: 'app_maintenance',
    passwordEnv: 'DB_ROLE_PASSWORD_APP_MAINTENANCE',
  },
];

const MIN_PASSWORD_LENGTH = 24;
/** Итераций больше, чем дефолтные 4096 в PostgreSQL: перебор дороже. */
const SCRAM_ITERATIONS = 15_000;
const SCRAM_SALT_BYTES = 16;
const SCRAM_KEY_BYTES = 32;

/**
 * SCRAM-SHA-256 верификатор в формате, который PostgreSQL хранит в
 * `pg_authid.rolpassword`:
 *   SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
 */
function scramVerifier(password: string): string {
  const salt = randomBytes(SCRAM_SALT_BYTES);
  const saltedPassword = pbkdf2Sync(
    password.normalize('NFKC'),
    salt,
    SCRAM_ITERATIONS,
    SCRAM_KEY_BYTES,
    'sha256',
  );
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}

function assertIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Недопустимое имя роли: ${name}`);
  return name;
}

/**
 * Собирает DDL на стороне сервера через format(): имена экранируются %I,
 * литералы — %L. Клиентской конкатенации строк нет.
 */
async function buildStatement(
  client: pg.Client,
  template: string,
  args: unknown[],
): Promise<string> {
  // Явное приведение к text обязательно: без него PostgreSQL не может вывести
  // тип параметра для полиморфного format() и падает с
  // «could not determine data type of parameter».
  const placeholders = args.map((_, i) => `$${i + 1}::text`).join(', ');
  const { rows } = await client.query<{ stmt: string }>(
    `SELECT format($fmt$${template}$fmt$, ${placeholders}) AS stmt`,
    args,
  );
  return rows[0]!.stmt;
}

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: ownerConnectionString(),
    ssl: sslConfig(),
    application_name: 'unicorn-bootstrap-roles',
  });
  await client.connect();

  try {
    for (const { login, group, passwordEnv } of ROLE_MAP) {
      const password = requireEnv(passwordEnv);
      if (password.length < MIN_PASSWORD_LENGTH) {
        throw new Error(
          `${passwordEnv}: пароль короче ${MIN_PASSWORD_LENGTH} символов. ` +
            'Короткий пароль сервисной роли — это дыра, а не неудобство.',
        );
      }
      const loginId = assertIdentifier(login);
      const groupId = assertIdentifier(group);
      const verifier = scramVerifier(password);

      const { rows } = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
        [loginId],
      );

      const ddl = rows[0]?.exists
        ? await buildStatement(
            client,
            'ALTER ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
            [loginId, verifier],
          )
        : await buildStatement(
            client,
            'CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',
            [loginId, verifier],
          );
      await client.query(ddl);

      await client.query(await buildStatement(client, 'GRANT %I TO %I', [groupId, loginId]));
      // Логин-пользователь работает ТОЛЬКО с правами своей группы.
      await client.query(
        await buildStatement(client, 'ALTER ROLE %I SET role = %I', [loginId, groupId]),
      );

      console.warn(`  ok  ${loginId} -> ${groupId}`);
    }

    // Публичный каталог обслуживается тем же процессом, но под ролью
    // app_public_read: у неё GRANT только на колонки тизера, поэтому даже
    // ошибка в SQL каталога не достанет непубличные поля. Чтобы переключиться,
    // логин-роль приложения обязана состоять в этой группе.
    //
    // Эскалации это не даёт: набор прав app_public_read строго уже, чем у
    // app_backend, — переключение идёт ВНИЗ по привилегиям, а не вверх.
    await client.query(
      await buildStatement(client, 'GRANT %I TO %I', ['app_public_read', 'app_backend_user']),
    );
    console.warn('  ok  app_backend_user -> app_public_read (переключение вниз для каталога)');

    // Контрольная проверка: ни у кого нет BYPASSRLS или SUPERUSER.
    const { rows } = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_%' AND (rolbypassrls OR rolsuper)`,
    );
    if (rows.length > 0) {
      throw new Error(`Роли с BYPASSRLS/SUPERUSER: ${rows.map((r) => r.rolname).join(', ')}`);
    }

    // И что пароли действительно хранятся как SCRAM, а не как md5 или plain.
    const weak = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_authid
        WHERE rolname LIKE 'app\\_%\\_user' AND (rolpassword IS NULL OR rolpassword NOT LIKE 'SCRAM-SHA-256$%')`,
    );
    if (weak.rows.length > 0) {
      throw new Error(`Роли без SCRAM-пароля: ${weak.rows.map((r) => r.rolname).join(', ')}`);
    }

    console.warn('\nВсе роли созданы. BYPASSRLS/SUPERUSER нет, пароли — SCRAM-SHA-256.\n');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\nОШИБКА BOOTSTRAP РОЛЕЙ: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
