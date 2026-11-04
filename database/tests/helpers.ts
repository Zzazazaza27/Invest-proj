/**
 * Хелперы интеграционных тестов схемы.
 *
 * Тесты работают против РЕАЛЬНОГО PostgreSQL 16 — RLS, триггеры и уровни
 * изоляции нельзя проверить моком. Фикстуры создаются от имени владельца,
 * а проверки доступа выполняются под настоящими сервисными ролями через
 * SET ROLE: иначе тест доказывал бы права владельца, а не приложения.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { testConnectionString, sslConfig } from '../src/env.ts';

export type Client = pg.PoolClient;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: testConnectionString(),
      ssl: sslConfig(),
      max: 12,
      application_name: 'fifth-db-tests',
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Одноразовая база под один тестовый файл.
 *
 * Нужна там, где проверка обязана КОММИТИТЬ: общая тестовая база копила бы
 * её строки от прогона к прогону, и «что лежит в базе» переставало бы
 * что-либо значить. Схема накатывается теми же миграциями, что и везде;
 * база удаляется в afterAll вместе со всем, что в ней появилось.
 */
export async function createScratchDatabase(name: string): Promise<{
  pool: pg.Pool;
  drop: () => Promise<void>;
}> {
  const base = new URL(testConnectionString());
  const admin = new pg.Client({
    connectionString: new URL('/postgres', base).href,
    ssl: sslConfig(),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(`/${name}`, base);
  url.search = base.search;
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const migrated = spawnSync(
    process.execPath,
    ['--experimental-strip-types', `${root}/database/src/migrate.ts`],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL_OWNER: url.href, DATABASE_URL_TEST: url.href },
    },
  );
  if (migrated.status !== 0) {
    throw new Error(
      `не удалось накатить миграции в ${name}: ${`${migrated.stdout ?? ''}${migrated.stderr ?? ''}`.slice(-400)}`,
    );
  }

  const scratchPool = new pg.Pool({
    connectionString: url.href,
    ssl: sslConfig(),
    max: 12,
    application_name: `fifth-db-tests-${name}`,
  });
  return {
    pool: scratchPool,
    async drop() {
      await scratchPool.end();
      const cleaner = new pg.Client({
        connectionString: new URL('/postgres', base).href,
        ssl: sslConfig(),
      });
      await cleaner.connect();
      await cleaner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleaner.end();
    },
  };
}

/** UUIDv7-совместимый идентификатор для фикстур (порядок по времени сохраняется). */
export function uuidv7(): string {
  const bytes = Buffer.alloc(16);
  const ms = Date.now();
  bytes.writeUIntBE(ms, 0, 6);
  Buffer.from(randomUUID().replace(/-/g, ''), 'hex').copy(bytes, 6, 6, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Выполняет работу в транзакции и ВСЕГДА откатывает её.
 * Тесты не оставляют следов и не зависят от порядка выполнения.
 */
export async function inRollbackTx<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

/**
 * Транзакция С КОММИТОМ — для тестов конкурентности, где нужны настоящие
 * блокировки: откат уничтожил бы то самое состояние, за которое борются
 * параллельные транзакции.
 *
 * `pool` передают, когда работа идёт не в общей тестовой базе, а в
 * одноразовой. Так устроен concurrency.test.ts: коммит ему необходим, а
 * оставлять строки навсегда — нет, поэтому у него своя база на один прогон.
 */
export async function inCommittedTx<T>(
  fn: (c: Client) => Promise<T>,
  pool: pg.Pool = getPool(),
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Сессионный контекст приложения: то, что выставляет middleware после проверки токена. */
export async function actAs(
  client: Client,
  opts: { userId?: string | null; roles?: string[]; dbRole?: string },
): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', opts.userId ?? '']);
  await client.query('SELECT set_config($1, $2, true)', [
    'app.current_roles',
    (opts.roles ?? []).join(','),
  ]);
  if (opts.dbRole) {
    // SET LOCAL ROLE — параметризовать нельзя, поэтому имя роли валидируется
    // по строгому allowlist, а не подставляется из произвольной строки.
    const allowed = new Set([
      'app_public_read',
      'app_backend',
      'app_notifications',
      'app_investments',
      'app_integration',
      'app_billing',
      'app_readonly',
      'app_maintenance',
      // Роль состояния аутентификации (M046). Через неё идут анонимные пути:
      // проверка рубежа сессий и работа со ссылками подтверждения (M060).
      'app_auth',
    ]);
    if (!allowed.has(opts.dbRole)) throw new Error(`Неизвестная роль БД: ${opts.dbRole}`);
    await client.query(`SET LOCAL ROLE ${opts.dbRole}`);
  }
}

export async function resetRole(client: Client): Promise<void> {
  await client.query('RESET ROLE');
}

/** Ожидает, что запрос упадёт, и возвращает ошибку. Пустой результат — тоже провал. */
export async function expectError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error('Ожидалась ошибка, но операция прошла успешно');
}

// ---------------------------------------------------------------- фикстуры

const FAKE_DEK = Buffer.from('00'.repeat(32), 'hex');

export interface UserFixture {
  id: string;
  email: string;
}

/** Создаёт пользователя. activate=true проходит все обязательные акцепты. */
export async function createUser(
  client: Client,
  opts: { role?: string; activate?: boolean; email?: string } = {},
): Promise<UserFixture> {
  const id = uuidv7();
  // Уникальность берём из СЛУЧАЙНОЙ части uuid, а не из префикса: первые
  // байты UUIDv7 — это метка времени, они совпадают у пользователей,
  // созданных в одном тесте, и дают коллизию blind index по email.
  const email = opts.email ?? `u-${id.slice(24)}@test.local`;
  const role = opts.role ?? 'founder';

  await client.query(
    `INSERT INTO identity.users
       (id, email_ciphertext, contact_wrapped_dek, email_hmac, display_name,
        primary_role, status)
     VALUES ($1, $2, $3, digest($4, 'sha256'), $5, $6, 'pending_consents')`,
    [id, Buffer.from(email), FAKE_DEK, email, `user-${id.slice(0, 6)}`, role],
  );
  await client.query(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2)`, [id, role]);

  if (opts.activate !== false) {
    await acceptRequiredConsents(client, id);
    await client.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [id]);
  }
  return { id, email };
}

/** Акцепт актуальных версий всех четырёх блокирующих документов. */
export async function acceptRequiredConsents(client: Client, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
     SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale, digest('test-trace', 'sha256')
     FROM identity.consent_templates t
     WHERE t.superseded_at IS NULL
       AND t.locale = 'ru-RU'
       AND t.kind IN ('platform_rules','tos','pdn','commission_terms')`,
    [userId],
  );
}

export async function createEntity(
  client: Client,
  ownerUserId: string,
  opts: { approvedKyb?: boolean } = {},
): Promise<string> {
  const id = uuidv7();
  // Уникальность — из случайного хвоста uuid, не из временного префикса.
  const inn = `77${id.slice(24)}`;
  await client.query(
    `INSERT INTO kyc.business_entities
       (id, legal_name, inn_ciphertext, entity_wrapped_dek, inn_hmac, jurisdiction,
        registry_status, owner_user_id)
     VALUES ($1, $2, $3, $4, digest($5, 'sha256'), 'RU', 'active', $6)`,
    [id, `ООО Тест ${id.slice(0, 6)}`, Buffer.from(inn), FAKE_DEK, inn, ownerUserId],
  );
  await client.query(
    `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, verified_at)
     VALUES ($1, $2, 'signatory', now())`,
    [id, ownerUserId],
  );
  if (opts.approvedKyb !== false) {
    // Проверяющий — посторонний администратор: с M013 решение по юрлицу,
    // принятое его владельцем или участником, отвергается триггером.
    const reviewer = await createUser(client, { role: 'admin' });
    await client.query(
      `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, reviewed_by, decided_at)
       VALUES (public.uuid_generate_v7(), $1, 'registry_check', 'approved', $2, now())`,
      [id, reviewer.id],
    );
  }
  return id;
}

/**
 * Одобренная верификация личности.
 *
 * Проверяющий создаётся отдельным пользователем осознанно: с миграции M013
 * решение по верификации без указанного проверяющего и решение «сам себе»
 * запрещены триггером. Фикстура обязана идти тем же путём, что и приложение,
 * иначе тесты доказывали бы работу схемы, которой не существует.
 */
export async function approveKyc(
  client: Client,
  userId: string,
  reviewerId?: string,
): Promise<void> {
  const reviewer = reviewerId ?? (await createUser(client, { role: 'admin' })).id;
  await client.query(
    `INSERT INTO kyc.kyc_verifications (id, user_id, kind, status, risk_level,
                                        sanctions_status, reviewed_by, decided_at)
     VALUES (public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now())`,
    [userId, reviewer],
  );
}

export async function createProject(
  client: Client,
  ownerUserId: string,
  opts: { ask?: number; listed?: boolean; status?: string } = {},
): Promise<string> {
  const id = uuidv7();
  const ask = opts.ask ?? 5_000_000;
  await client.query(
    `INSERT INTO lab.projects (id, title, stage, investment_ask, status)
     VALUES ($1, $2, 'mvp', $3, $4)`,
    [id, `Проект ${id.slice(0, 6)}`, ask, opts.status ?? 'draft'],
  );
  await client.query(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [id, ownerUserId],
  );

  if (opts.listed) {
    // С M087 листинг — следствие режима видимости: опубликованный проект в
    // фикстуре получает режим public (тизер), как и при переносе данных.
    await client.query(
      `UPDATE lab.projects
          SET listing_status = 'listed', listed_at = now(),
              visibility = 'public', visibility_changed_at = now()
        WHERE id = $1`,
      [id],
    );
  }
  return id;
}
