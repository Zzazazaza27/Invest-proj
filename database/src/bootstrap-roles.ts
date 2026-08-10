/**
 * Создание логин-пользователей БД из переменных окружения.
 *
 * Групповые роли (app_backend, app_billing, …) создаёт миграция M000 как
 * NOLOGIN — в миграциях нет и не должно быть паролей. Этот скрипт заводит
 * логин-пользователей и включает их в соответствующие группы.
 *
 * Запуск: npm run bootstrap:roles -w database
 */
import pg from 'pg';
import { ownerConnectionString, requireEnv, sslConfig } from './env.ts';

/** Логин-пользователь → групповая роль, права которой он получает. */
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
];

const MIN_PASSWORD_LENGTH = 24;

function assertIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Недопустимое имя роли: ${name}`);
  return name;
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

      const { rows } = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
        [loginId],
      );

      // Имя роли нельзя передать параметром, поэтому оно проверено allowlist'ом
      // выше; пароль передаётся как литерал через format(%L) на стороне сервера.
      if (rows[0]?.exists) {
        await client.query(
          `DO $do$ BEGIN EXECUTE format('ALTER ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD %L', $1, $2); END $do$`,
          [loginId, password],
        );
      } else {
        await client.query(
          `DO $do$ BEGIN EXECUTE format('CREATE ROLE %I LOGIN NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1, $2); END $do$`,
          [loginId, password],
        );
      }
      await client.query(`DO $do$ BEGIN EXECUTE format('GRANT %I TO %I', $1, $2); END $do$`, [
        groupId,
        loginId,
      ]);
      // Логин-пользователь работает ТОЛЬКО с правами своей группы.
      await client.query(
        `DO $do$ BEGIN EXECUTE format('ALTER ROLE %I SET role = %I', $1, $2); END $do$`,
        [loginId, groupId],
      );
      console.warn(`  ✔ ${loginId} → ${groupId}`);
    }

    // Контрольная проверка: ни у кого нет BYPASSRLS или SUPERUSER.
    const { rows } = await client.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname LIKE 'app\\_%' AND (rolbypassrls OR rolsuper)`,
    );
    if (rows.length > 0) {
      throw new Error(`Роли с BYPASSRLS/SUPERUSER: ${rows.map((r) => r.rolname).join(', ')}`);
    }
    console.warn('\nВсе роли созданы, BYPASSRLS/SUPERUSER ни у кого нет.\n');
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
