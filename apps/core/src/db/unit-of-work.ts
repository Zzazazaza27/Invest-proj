import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { getEnv } from '../config/env';

/**
 * Доступ к БД.
 *
 * Каждая транзакция начинается с установки сессионного контекста
 * (`app.current_user_id`, `app.current_roles`) — именно на нём построены все
 * RLS-политики. Запрос без контекста видит ровно ничего: политики закрыты
 * по умолчанию, а не открыты.
 *
 * Прямых подключений клиентов к БД не существует; приложение работает под
 * ролью без BYPASSRLS.
 */

export interface RequestContext {
  userId: string | null;
  roles: readonly string[];
  traceId: string;
}

export type Tx = pg.PoolClient;

/** Числовые типы PostgreSQL не приводятся к JS number: NUMERIC → строка. */
function configureTypeParsers(): void {
  const types = pg.types;
  // 1700 = NUMERIC. Приведение к number потеряло бы копейки на больших суммах.
  types.setTypeParser(1700, (value) => value);
  // 20 = INT8. Значения свыше 2^53 не представимы точно в number.
  types.setTypeParser(20, (value) => value);
}
configureTypeParsers();

@Injectable()
export class Database implements OnModuleDestroy {
  private readonly logger = new Logger(Database.name);
  private readonly pool: pg.Pool;
  private readonly statementTimeoutMs: number;
  /** Пулы сервисных ролей: у каждой свой логин-пользователь и свои права. */
  private readonly servicePools = new Map<ServiceRole, pg.Pool>();

  constructor() {
    const env = getEnv();
    this.statementTimeoutMs = env.DATABASE_STATEMENT_TIMEOUT_MS;
    this.pool = this.createPool(env.DATABASE_URL, 'unicorn-launch-core', env.DATABASE_POOL_MAX);
  }

  private createPool(connectionString: string, applicationName: string, max: number): pg.Pool {
    const env = getEnv();
    const pool = new pg.Pool({
      connectionString,
      ssl: env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
      max,
      application_name: applicationName,
      // Запрос без ограничения времени держит соединение и блокировки бесконечно.
      statement_timeout: env.DATABASE_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (error) => {
      // Ошибка простаивающего соединения не должна ронять процесс.
      this.logger.error({
        msg: 'ошибка пула соединений',
        pool: applicationName,
        error: error.message,
      });
    });
    return pool;
  }

  /**
   * Пул сервисной роли.
   *
   * Соединение открывается под собственной логин-ролью, а не через `SET ROLE` с
   * подключения приложения: `app_backend_user` не состоит в сервисных группах и
   * переключиться в них не может — это и есть граница, ради которой роли
   * разделены (Database_Launch §1). Не настроен URL — контур недоступен.
   */
  private serviceRolePool(role: ServiceRole): pg.Pool {
    const existing = this.servicePools.get(role);
    if (existing) return existing;

    const env = getEnv();
    const url = SERVICE_ROLE_URLS[role](env);
    if (!url) {
      throw new Error(
        `Сервисная роль ${role} не настроена: задай ${SERVICE_ROLE_ENV_KEYS[role]}. ` +
          'Выполнять её операции под ролью приложения запрещено.',
      );
    }
    // Пул сервисной роли меньше пользовательского: это редкие команды, а не
    // поток запросов, и лишние соединения занимали бы слоты БД впустую.
    const pool = this.createPool(url, `unicorn-launch-${role}`, SERVICE_POOL_MAX);
    this.servicePools.set(role, pool);
    return pool;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
    for (const pool of this.servicePools.values()) await pool.end();
    this.servicePools.clear();
  }

  /**
   * Транзакция с установленным контекстом RLS.
   *
   * `SET LOCAL` действует до конца транзакции, поэтому контекст не «протекает»
   * на следующий запрос, взявший то же соединение из пула. Это принципиально:
   * при `SET SESSION` чужой пользовательский контекст пережил бы запрос.
   */
  async transaction<T>(ctx: RequestContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.applyContext(client, ctx);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Транзакция только для чтения: планировщику и репликам это явный сигнал. */
  async readOnly<T>(ctx: RequestContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await this.applyContext(client, ctx);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Транзакция от имени сервисной роли (банковские события, денежные команды,
   * доставка уведомлений). Пользовательского контекста здесь нет намеренно.
   */
  async asServiceRole<T>(
    role: ServiceRole,
    ctx: Omit<RequestContext, 'userId' | 'roles'>,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    if (!SERVICE_ROLES.has(role)) {
      throw new Error(`Недопустимая сервисная роль: ${role}`);
    }
    const client = await this.serviceRolePool(role).connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
      // Логин-пользователь и так входит только в свою группу; явный SET ROLE —
      // проверка того, что соединение действительно взято из нужного пула.
      // Имя роли не параметризуется, поэтому проверено по allowlist выше.
      await client.query(`SET LOCAL ROLE ${role}`);
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', '']);
      await client.query('SELECT set_config($1, $2, true)', ['app.current_roles', 'system']);
      await client.query('SELECT set_config($1, $2, true)', ['app.trace_id', ctx.traceId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Транзакция от имени публичной роли — для анонимного каталога.
   *
   * Роль `app_public_read` имеет GRANT только на allowlist колонок тизера, а её
   * RLS-политика отдаёт исключительно строки `listing_status='listed'`. Даже
   * ошибка в SQL каталога не сможет вытащить чужой черновик: прав на остальные
   * колонки у роли просто нет.
   */
  async asPublicRole<T>(traceId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL ROLE app_public_read');
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
      await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', '']);
      await client.query('SELECT set_config($1, $2, true)', ['app.current_roles', '']);
      await client.query('SELECT set_config($1, $2, true)', ['app.trace_id', traceId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async applyContext(client: pg.PoolClient, ctx: RequestContext): Promise<void> {
    await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_user_id',
      ctx.userId ?? '',
    ]);
    await client.query('SELECT set_config($1, $2, true)', [
      'app.current_roles',
      ctx.roles.join(','),
    ]);
    await client.query('SELECT set_config($1, $2, true)', ['app.trace_id', ctx.traceId]);
  }

  /** Проверка живости для /v1/health. */
  async ping(): Promise<boolean> {
    try {
      const { rows } = await this.pool.query<{ ok: number }>('SELECT 1 AS ok');
      return rows[0]?.ok === 1;
    } catch {
      return false;
    }
  }
}

export const SERVICE_ROLES = new Set([
  'app_investments',
  'app_billing',
  'app_notifications',
  'app_integration',
  'app_maintenance',
  'app_auth',
] as const);

export type ServiceRole =
  | 'app_investments'
  | 'app_billing'
  | 'app_notifications'
  | 'app_integration'
  /** Плановое обслуживание: уборка реестра отзывов и брошенных билетов (M039). */
  | 'app_maintenance'
  /**
   * Чтение состояния сессий: рубеж и реестр отозванных токенов (M046).
   *
   * Отдельно от `app_notifications`, которой это доставалось раньше: у той есть
   * `SELECT` по пользователям и ролям целиком, а проверке входа нужны две
   * колонки и одна маленькая таблица (SEC-21).
   */
  | 'app_auth';

/** Небольшой пул: сервисные команды редки, соединения БД — общий ресурс. */
const SERVICE_POOL_MAX = 4;

/**
 * Откуда берётся строка подключения каждой сервисной роли.
 *
 * Пустая строка означает, что контур не настроен: попытка его использовать
 * падает явной ошибкой с именем недостающей переменной, а не исполняется молча
 * под правами пользовательской роли (ADR-006). Это поведение сохраняется и
 * после настройки — оно про отсутствующую конфигурацию, а не про фазу проекта.
 */
const SERVICE_ROLE_URLS: Record<ServiceRole, (env: ReturnType<typeof getEnv>) => string> = {
  app_investments: (env) => env.DATABASE_URL_APP_INVESTMENTS,
  app_billing: (env) => env.DATABASE_URL_APP_BILLING,
  app_notifications: (env) => env.DATABASE_URL_APP_NOTIFICATIONS,
  app_integration: (env) => env.DATABASE_URL_APP_INTEGRATION,
  app_maintenance: (env) => env.DATABASE_URL_APP_MAINTENANCE,
  app_auth: (env) => env.DATABASE_URL_APP_AUTH,
};

const SERVICE_ROLE_ENV_KEYS: Record<ServiceRole, string> = {
  app_investments: 'DATABASE_URL_APP_INVESTMENTS',
  app_billing: 'DATABASE_URL_APP_BILLING',
  app_notifications: 'DATABASE_URL_APP_NOTIFICATIONS',
  app_integration: 'DATABASE_URL_APP_INTEGRATION',
  app_maintenance: 'DATABASE_URL_APP_MAINTENANCE',
  app_auth: 'DATABASE_URL_APP_AUTH',
};
