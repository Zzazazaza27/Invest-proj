import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { errors } from '../common/errors';
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
  /**
   * Запрос выполняется в режиме просмотра чужого кабинета: доменные изменения
   * запрещены (M129).
   *
   * Проверка стоит ЗДЕСЬ, а не только в страже доступа, потому что запрет по
   * методу HTTP неполон: изменения бывают неявные — отметка уведомления
   * прочитанным происходит на чтении страницы. Любая пишущая транзакция
   * проходит через `transaction()`, поэтому запрет в одной точке закрывает и
   * те пути, о которых никто не вспомнил.
   *
   * Обязательный аудит от этого не страдает: в режиме просмотра доменных
   * операций нет вовсе, а записи о начале и завершении просмотра делает
   * администратор в СВОЁМ контексте.
   */
  viewOnly?: boolean;
  /**
   * Кто открыл просмотр. Нужен журналу: запись обязана различать инициатора и
   * того, от чьего лица выполнен запрос.
   */
  initiatorUserId?: string | null;
  /**
   * Тестовая сессия, от лица участника которой идёт запрос (M129).
   *
   * Нужна, чтобы созданное участником числилось за сессией: иначе уборка
   * уберёт самих участников, а их проекты останутся в каталоге, и объяснить
   * это человеку будет нечем.
   */
  testSessionId?: string | null;
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

  /**
   * Взять соединение из пула ТАК, чтобы его обрыв не уронил процесс.
   *
   * `pool.on('error')` закрывает только ПРОСТАИВАЮЩИЕ соединения. У клиента,
   * который уже выдан и работает, событие `error` эмитится на нём самом — и
   * без слушателя Node бросает его как необработанное, то есть убивает ядро.
   *
   * Так и случилось 22.09: гибернация оборвала соединение, занятое фоновым
   * проходом. Перехват в задаче от этого НЕ спасает: до отклонения промиса
   * дело не доходит, процесс умирает раньше. Поэтому слушатель вешается на
   * каждое выданное соединение и снимается при возврате — иначе они
   * накапливались бы на переиспользуемых клиентах пула.
   *
   * Сам запрос всё равно завершится отказом; его разбирает вызывающий.
   */
  private async acquire(
    pool: pg.Pool,
    label: string,
  ): Promise<{ client: pg.PoolClient; release: () => void }> {
    const client = await pool.connect();
    const onError = (error: Error): void => {
      this.logger.error({ msg: 'обрыв выданного соединения', pool: label, error: error.message });
    };
    client.on('error', onError);
    return {
      client,
      release: () => {
        client.removeListener('error', onError);
        client.release();
      },
    };
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
    if (ctx.viewOnly) {
      // Отказ, а не молчаливое чтение: «изменение не состоялось» обязано быть
      // видно и вызывающему, и в разборе. Тихий пропуск записи создал бы
      // худшее из состояний — интерфейс показывает успех, данных нет.
      throw errors.forbidden({
        stage: 'view-only',
        detail: 'просмотр кабинета: изменения запрещены сервером',
      });
    }
    const { client, release } = await this.acquire(this.pool, 'core');
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
      release();
    }
  }

  /** Транзакция только для чтения: планировщику и репликам это явный сигнал. */
  async readOnly<T>(ctx: RequestContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    const { client, release } = await this.acquire(this.pool, 'core');
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
      release();
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
    const { client, release } = await this.acquire(this.serviceRolePool(role), role);
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
      release();
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
  /**
   * Публичная роль: таблицы — только allowlist тизера. `viewer` — проверенная
   * сессия зрителя (если есть): роль БД остаётся публичной, но предикат
   * аудитории проекта (`lab.project_audience`) решает по ней, что зрителю
   * открыто: допущенному инвестору — его проекты, анониму — публичные.
   */
  async asPublicRole<T>(
    traceId: string,
    work: (tx: Tx) => Promise<T>,
    viewer: { userId: string | null; roles: readonly string[] } | null = null,
  ): Promise<T> {
    const { client, release } = await this.acquire(this.pool, 'public');
    try {
      await client.query('BEGIN READ ONLY');
      await client.query('SET LOCAL ROLE app_public_read');
      await client.query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_user_id',
        viewer?.userId ?? '',
      ]);
      await client.query('SELECT set_config($1, $2, true)', [
        'app.current_roles',
        viewer?.userId ? viewer.roles.join(',') : '',
      ]);
      await client.query('SELECT set_config($1, $2, true)', ['app.trace_id', traceId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      release();
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

  /**
   * Размер и возраст очередей (служебный порт `/queues`, блок 8, 8.3): одна
   * функция БД без идентификаторов и содержимого (M152).
   */
  async queueMetrics(): Promise<Record<string, Record<string, number>>> {
    const { rows } = await this.pool.query<{ m: Record<string, Record<string, number>> }>(
      'SELECT audit.queue_metrics() AS m',
    );
    return rows[0]?.m ?? {};
  }

  /** Контрольная запись наблюдения (M153): ключ файла, размер, SHA-256. */
  async controlObject(
    name: string,
  ): Promise<{ s3Key: string; sizeBytes: number; sha256: string } | null> {
    const { rows } = await this.pool.query<{
      o: { s3Key: string; sizeBytes: number; sha256: string } | null;
    }>('SELECT audit.control_object($1) AS o', [name]);
    return rows[0]?.o ?? null;
  }

  /** Служебная учётка мониторинга (M155) — для ограничения её действий. */
  async isMonitoringUser(userId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ v: boolean }>(
      'SELECT identity.is_monitoring_user($1) AS v',
      [userId],
    );
    return rows[0]?.v === true;
  }

  /** Контрольный проект мониторинга (M155). */
  async isMonitoringProject(projectId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ v: boolean }>(
      'SELECT lab.is_monitoring_project($1) AS v',
      [projectId],
    );
    return rows[0]?.v === true;
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
  'app_notifications',
  'app_integration',
  'app_maintenance',
  'app_auth',
] as const);

export type ServiceRole =
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
  app_notifications: (env) => env.DATABASE_URL_APP_NOTIFICATIONS,
  app_integration: (env) => env.DATABASE_URL_APP_INTEGRATION,
  app_maintenance: (env) => env.DATABASE_URL_APP_MAINTENANCE,
  app_auth: (env) => env.DATABASE_URL_APP_AUTH,
};

const SERVICE_ROLE_ENV_KEYS: Record<ServiceRole, string> = {
  app_notifications: 'DATABASE_URL_APP_NOTIFICATIONS',
  app_integration: 'DATABASE_URL_APP_INTEGRATION',
  app_maintenance: 'DATABASE_URL_APP_MAINTENANCE',
  app_auth: 'DATABASE_URL_APP_AUTH',
};
