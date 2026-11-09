import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { AuditRepository } from '../audit/audit.repository';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { noteBasis } from '../audit/actor-context';
import { AccessContextService } from '../auth/access-context.service';
import type { TestingSession } from '@fifth/contracts';

/** Происхождения, которые считаются следом прогона (M127). */
const PROBE_ORIGINS = new Set(['render_check', 'load_test', 'test_session']);

/**
 * Строка базы в вид договора. Отдельной функцией, потому что список и
 * карточка обязаны отдавать одно и то же: разошедшиеся представления одной
 * сущности — способ получить два разных экрана про один объект.
 */
function toSession(row: SessionRow): TestingSession {
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    status: row.status as TestingSession['status'],
    result: row.result as TestingSession['result'],
    environment: row.environment,
    scenarioId: row.scenario_id,
    codeVersion: row.code_version,
    cleanupError: row.cleanup_error,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    lastActiveAt: row.last_active_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    cleanedAt: row.cleaned_at?.toISOString() ?? null,
  };
}

/**
 * Тестовые сессии: ручной проход и автоматический прогон одним механизмом.
 *
 * ЗАЧЕМ ОДНИМ. Раньше каждая проверка строила обстановку по-своему, и разбор
 * упавшего прогона сводился к чтению чужого скрипта. Теперь и человек, и
 * прогон получают одно и то же: набор участников, к которым можно вернуться,
 * и запись с шагами, результатом и перечнем созданного.
 *
 * ГРАНИЦА, КОТОРУЮ ДЕРЖИТ БАЗА. Участником сессии становится только запись
 * происхождения `test_session` (триггер M129). Рабочий пользователь в
 * участники не попадает никогда — значит уборка сессии до него не дотянется.
 */

export interface SessionRow {
  id: string;
  title: string;
  source: 'manual' | 'automated';
  status: string;
  result: string;
  environment: string;
  scenario_id: string | null;
  code_version: string | null;
  cleanup_error: string | null;
  created_by: string;
  created_at: Date;
  last_active_at: Date;
  finished_at: Date | null;
  cleaned_at: Date | null;
}

/** Состав стандартного сценария: с кем владелец проходит платформу. */
interface SealedParticipant {
  userId: string;
  tag: string;
  contact: { ciphertexts: { email: Buffer | null; phone: Buffer | null }; wrappedDek: Buffer };
  emailIndex: Buffer;
}

const STANDARD_CAST = [
  { role: 'founder' as const, label: 'Основатель' },
  { role: 'investor' as const, label: 'Инвестор' },
];

/** Сколько живёт контекст доступа. Верхнюю границу держит и схема (12 ч). */
const CONTEXT_TTL_MINUTES = 120;

@Injectable()
export class TestingSessionsService {
  private readonly logger = new Logger(TestingSessionsService.name);

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
    private readonly contexts: AccessContextService,
  ) {}

  /**
   * Механизм доступен только в тестовом контуре.
   *
   * Проверка стоит на каждом входе в службу, а не только в страже: службу
   * вызывают и из прогонов, и из будущих команд, и «забыли проверить» здесь
   * означает работающую подстановку личности на бою.
   */
  private assertEnabled(): void {
    if (!this.contexts.isEnabled()) {
      throw errors.forbidden({
        stage: 'testing-disabled',
        detail: 'тестовые сессии доступны только в тестовом контуре',
      });
    }
  }

  // ------------------------------------------------------------- создание

  async create(
    ctx: RequestContext,
    input: {
      title: string;
      source?: 'manual' | 'automated';
      scenarioId?: string | null;
      codeVersion?: string | null;
      withStandardCast?: boolean;
    },
  ): Promise<{ id: string; runToken: string }> {
    this.assertEnabled();
    if (!ctx.userId) throw errors.unauthenticated({ stage: 'no-user' });

    const sessionId = randomUUID();
    /*
     * СЕКРЕТ ЗАПУСКА.
     *
     * Идентификатор сессии не секрет: он печатается прогонами, виден в
     * админке, попадает в отчёты. Пока право создавать записи от имени
     * запуска подтверждалось идентификатором, посторонний, узнавший его, мог
     * подвести свои записи под чужую уборку — это было проверено опытом, а не
     * предположено. Поэтому у запуска есть секрет: он отдаётся ОДИН раз тому,
     * кто сессию создал, а в базе остаётся только его SHA-256.
     */
    const runToken = randomBytes(32).toString('base64url');
    const runTokenHash = createHash('sha256').update(runToken, 'utf8').digest();
    const env = getEnv();

    const sealedCast =
      input.withStandardCast === false
        ? []
        : await Promise.all(STANDARD_CAST.map(() => this.sealParticipant()));

    await this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO testing.sessions
           (id, title, source, created_by, environment, scenario_id, code_version,
            run_token_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          sessionId,
          input.title.trim(),
          input.source ?? 'manual',
          ctx.userId,
          env.NODE_ENV,
          input.scenarioId ?? null,
          input.codeVersion ?? null,
          runTokenHash,
        ],
      );

      if (input.withStandardCast !== false) {
        for (const member of STANDARD_CAST) {
          await this.addParticipant(
            tx,
            ctx,
            sessionId,
            member.role,
            member.label,
            sealedCast.shift()!,
          );
        }
      }

      await this.audit.record(tx, {
        verb: 'testing.session.created',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'testing_session',
        aggregateId: sessionId,
        aggregateVersion: 1,
        payload: { title: input.title.trim(), source: input.source ?? 'manual' },
        traceId: ctx.traceId,
        // В поток событий это не идёт: контур проверки — не предмет
        // интереса внешних подписчиков, а версия агрегата у сессии одна,
        // и вторая запись столкнулась бы с уникальностью outbox.
        publish: false,
      });
    });

    return { id: sessionId, runToken };
  }

  /** Контакт участника готовится до транзакции: она не ждёт службу ключей. */
  private async sealParticipant(): Promise<SealedParticipant> {
    const userId = randomUUID();
    const tag = userId.slice(0, 8);
    const email = `session-${tag}@test.invalid`;
    // Домен `test.invalid` зарезервирован стандартом и не разрешается в
    // сеть: даже если однажды что-то попробует написать участнику письмо,
    // адресата не существует по построению.
    return {
      userId,
      tag,
      contact: await this.crypto.sealMany('passport_sensitive', { email, phone: null }),
      emailIndex: await this.crypto.blindIndex(email, 'email'),
    };
  }

  /**
   * Участник сессии — отдельная учётная запись.
   *
   * Пароль не задаётся никогда: вход под участником не предусмотрен, доступ
   * к его кабинету идёт только через контекст. В поле пароля лежит хеш от
   * случайных байт, которые никуда не сохраняются, — подобрать нечего, войти
   * нельзя. Это честнее пустого значения: «нет пароля» в схеме означало бы
   * «вход без пароля» для любого пути, который забудет это проверить.
   */
  private async addParticipant(
    tx: Tx,
    ctx: RequestContext,
    sessionId: string,
    role: 'founder' | 'investor' | 'corporate',
    label: string,
    sealed: SealedParticipant,
  ): Promise<string> {
    const { userId, tag, contact, emailIndex } = sealed;
    const unusable = await argon2.hash(randomBytes(32).toString('base64'), {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    await tx.query(
      `INSERT INTO identity.users
         (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash,
          display_name, primary_role, status, locale, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_consents', 'ru-RU', 'test_session')`,
      [
        userId,
        contact.ciphertexts.email,
        contact.wrappedDek,
        emailIndex,
        unusable,
        `${label} · ${tag}`,
        role,
      ],
    );

    // `granted_by` обязателен: политика M054 требует, чтобы администратор
    // выдавал роль от своего имени — подделать выдачу нельзя.
    await tx.query(
      `INSERT INTO identity.user_roles (user_id, role, granted_by) VALUES ($1, $2, $3)`,
      [userId, role, ctx.userId],
    );

    // Акцепты обязательных документов: без них учётная запись не
    // активируется, и участник не воспроизводил бы обычного пользователя.
    //
    // Политика «акцепт только за себя» (M002) не пропускает вставку от имени
    // администратора — и правильно делает: подделка чужого согласия не
    // должна быть возможна даже администратору. Поэтому контекст сессии БД
    // на время вставки переключается на самого участника — тем же приёмом,
    // что и обычная регистрация, — и сразу возвращается обратно.
    await tx.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
    await tx.query('SELECT set_config($1, $2, true)', ['app.current_roles', role]);
    try {
      await tx.query(
        `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
         SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale, digest($2, 'sha256')
           FROM identity.consent_templates t
          WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
            AND t.kind IN ('platform_rules','tos','pdn','commission_terms')`,
        [userId, `testing-session-${sessionId}`],
      );
    } finally {
      // Возврат обязателен и в случае ошибки: иначе остаток транзакции —
      // создание других участников и запись в журнал — выполнится от лица
      // участника, и журнал соврёт о том, кто это сделал.
      await tx.query('SELECT set_config($1, $2, true)', ['app.current_user_id', ctx.userId]);
      await tx.query('SELECT set_config($1, $2, true)', ['app.current_roles', ctx.roles.join(',')]);
    }
    await tx.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [userId]);

    await tx.query(
      `INSERT INTO testing.session_participants (session_id, user_id, role, label)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, userId, role, label],
    );
    // Участник — объект сессии: уборка обязана знать о нём по перечню, а не
    // выводить его из таблицы участников. Перечень один на всё созданное.
    await this.trackObject(tx, sessionId, 'identity.users', userId);
    return userId;
  }

  /** Записать, что объект создан этой сессией. По перечню работает уборка. */
  async trackObject(tx: Tx, sessionId: string, table: string, rowId: string): Promise<void> {
    await tx.query(
      `INSERT INTO testing.session_objects (session_id, table_name, row_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [sessionId, table, rowId],
    );
  }

  /**
   * Найти действующий запуск по СЕКРЕТУ.
   *
   * Принимает не идентификатор сессии, а выданный при её создании секрет:
   * знание того, что «запуск с таким-то id идёт», права создавать записи от
   * его имени не даёт. Возвращает идентификатор либо null и ничего не
   * рассказывает о самой сессии — существование чужого запуска тоже
   * сведения.
   */
  async runByToken(token: string): Promise<string | null> {
    if (!this.contexts.isEnabled()) return null;
    const hash = createHash('sha256').update(token, 'utf8').digest();
    return this.db.readOnly({ userId: null, roles: [], traceId: 'run-check' }, async (tx) => {
      const { rows } = await tx.query<{ id: string | null }>(
        `SELECT testing.run_by_token($1) AS id`,
        [hash],
      );
      return rows[0]?.id ?? null;
    });
  }

  /**
   * Принять объект, созданный прогоном, в перечень своей сессии.
   *
   * ЗАЧЕМ ОТДЕЛЬНЫЙ МАРШРУТ. Происхождение (`origin`) говорит «это завёл
   * прогон», но не «вот ЭТОТ запуск». Без принадлежности уборка возможна
   * только оптом — по классу записей, — а значит один прогон убирает следы
   * другого, ещё работающего. Перечень сессии эту разницу и хранит.
   *
   * ПОЧЕМУ РОЛЬ УЧАСТНИКА ЗДЕСЬ НИ ПРИ ЧЁМ. Прогон, работающий под
   * администратором, ничего не знает про участников сессии — ему нужен
   * только учёт. Требовать ради этого админа среди участников значило бы
   * выдавать административные права там, где нужна одна строка в журнале.
   *
   * ЧЕТЫРЕ РУБЕЖА, и каждый закрывает свой способ ошибиться:
   *   1. полномочие `testing.sessions.manage` — как у остальных маршрутов;
   *   2. сессия принадлежит ТОМУ, кто её открыл: чужую пополнить нельзя;
   *   3. завершённую и убранную пополнить нельзя — иначе запись появилась бы
   *      в перечне уже после уборки и осталась бы навсегда;
   *   4. таблица из закрытого списка, а строка обязана БЫТЬ ЗАПИСЬЮ ПРОВЕРКИ.
   *      Без этого администратор мог бы внести в перечень настоящего
   *      человека и удалить его следующей же уборкой.
   */
  async trackCreated(
    ctx: RequestContext,
    sessionId: string,
    input: { table: string; id: string },
  ): Promise<{ tracked: true }> {
    this.assertEnabled();
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ created_by: string; status: string; created_at: Date }>(
        // Состояние берётся из `status`, а не из `result`: у результата есть
        // умолчание 'unknown', то есть он заполнен с самого начала и о ходе
        // сессии не говорит ничего.
        `SELECT created_by, status, created_at FROM testing.sessions WHERE id = $1`,
        [sessionId],
      );
      const session = rows[0];
      if (!session) throw errors.notFound({ subject: 'testing session', id: sessionId });
      if (session.created_by !== ctx.userId) {
        throw errors.forbidden({
          reason: 'чужая сессия: пополнять перечень вправе только тот, кто её открыл',
        });
      }
      const startedAt = session.created_at;
      if (session.status !== 'active') {
        throw errors.conflict('Сессия не активна', {
          reason: 'запись, добавленная после итога, уборкой уже не убирается',
          status: session.status,
        });
      }

      const found = await tx.query<{ origin: string; created_at: Date }>(
        input.table === 'identity.users'
          ? `SELECT origin, created_at FROM identity.users WHERE id = $1`
          : `SELECT origin, created_at FROM lab.projects WHERE id = $1`,
        [input.id],
      );
      const row = found.rows[0];
      if (!row) throw errors.notFound({ subject: input.table, id: input.id });
      if (!PROBE_ORIGINS.has(row.origin)) {
        throw errors.forbidden({
          reason:
            'это не запись проверки: в перечень сессии попадает только созданное прогоном, ' +
            'иначе уборка удалила бы настоящие данные',
        });
      }

      /*
       * ПРИЗНАК «ТЕСТОВЫЙ» НЕ ДОКАЗЫВАЕТ ПРИНАДЛЕЖНОСТЬ.
       *
       * Без следующих двух проверок любой прогон мог бы записать за собой
       * чужие тестовые записи — и снести их своей уборкой, пока другой
       * прогон ими ещё пользуется.
       *
       * Первое: объект, уже числящийся за другой сессией, не отбирается.
       * Второе: объект, появившийся ДО начала этой сессии, ей принадлежать
       * не может — запуск не создаёт того, что было раньше него.
       */
      const owner = await tx.query<{ session_id: string }>(
        `SELECT session_id FROM testing.session_objects
          WHERE table_name = $1 AND row_id = $2 LIMIT 1`,
        [input.table, input.id],
      );
      const currentOwner = owner.rows[0]?.session_id;
      if (currentOwner && currentOwner !== sessionId) {
        throw errors.conflict('Объект принадлежит другому запуску', {
          reason: 'забрать чужое созданное нельзя: его уберёт та сессия, которая его завела',
        });
      }
      if (row.created_at < startedAt) {
        throw errors.forbidden({
          reason:
            'объект появился раньше этого запуска: принадлежность запуску — это факт создания, ' +
            'а не совпадение признака «тестовый»',
        });
      }

      await this.trackObject(tx, sessionId, input.table, input.id);
      return { tracked: true as const };
    });
  }

  // --------------------------------------------------------------- чтение

  async list(ctx: RequestContext): Promise<TestingSession[]> {
    this.assertEnabled();
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<SessionRow>(
        `SELECT * FROM testing.sessions ORDER BY last_active_at DESC LIMIT 200`,
      );
      return rows.map(toSession);
    });
  }

  async card(ctx: RequestContext, sessionId: string) {
    this.assertEnabled();
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<SessionRow>('SELECT * FROM testing.sessions WHERE id = $1', [
        sessionId,
      ]);
      const session = rows[0];
      if (!session) throw errors.notFound({ what: 'testing_session' });

      const participants = await tx.query<{
        user_id: string;
        role: string;
        label: string;
        display_name: string;
        status: string;
      }>(
        `SELECT p.user_id, p.role, p.label, u.display_name, u.status
           FROM testing.session_participants p
           JOIN identity.users u ON u.id = p.user_id
          WHERE p.session_id = $1
          ORDER BY p.created_at`,
        [sessionId],
      );
      const steps = await tx.query<{
        ordinal: number;
        name: string;
        status: 'passed' | 'failed' | 'skipped';
        actor: string | null;
        expected: string | null;
        actual: string | null;
        created_at: Date;
      }>(
        `SELECT ordinal, name, status, actor, expected, actual, created_at
           FROM testing.session_steps WHERE session_id = $1 ORDER BY ordinal`,
        [sessionId],
      );
      const objects = await tx.query<{ table_name: string; n: number }>(
        `SELECT table_name, count(*)::int AS n
           FROM testing.session_objects WHERE session_id = $1
          GROUP BY table_name ORDER BY 1`,
        [sessionId],
      );
      return {
        session: toSession(session),
        participants: participants.rows.map((row) => ({
          userId: row.user_id,
          role: row.role,
          label: row.label,
          displayName: row.display_name,
          status: row.status,
        })),
        steps: steps.rows.map((row) => ({
          ordinal: row.ordinal,
          name: row.name,
          status: row.status,
          actor: row.actor,
          expected: row.expected,
          actual: row.actual,
          createdAt: row.created_at.toISOString(),
        })),
        objects: objects.rows.map((row) => ({ table: row.table_name, count: row.n })),
      };
    });
  }

  /**
   * Записать шаг прогона.
   *
   * Шаги — материал разбора, а не отчёт: в них ожидаемое и фактическое, но
   * НЕ секреты и не персональные данные. Ограничение длины стоит в схеме —
   * сюда не должен уехать дамп ответа целиком.
   */
  async addStep(
    ctx: RequestContext,
    sessionId: string,
    input: {
      ordinal: number;
      name: string;
      status: 'passed' | 'failed' | 'skipped';
      actor?: string | null;
      expected?: string | null;
      actual?: string | null;
    },
  ): Promise<void> {
    this.assertEnabled();
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `INSERT INTO testing.session_steps
           (id, session_id, ordinal, name, status, actor, expected, actual)
         VALUES (public.uuid_generate_v7(), $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (session_id, ordinal) DO UPDATE
            SET name = EXCLUDED.name, status = EXCLUDED.status, actor = EXCLUDED.actor,
                expected = EXCLUDED.expected, actual = EXCLUDED.actual`,
        [
          sessionId,
          input.ordinal,
          input.name.slice(0, 200),
          input.status,
          input.actor?.slice(0, 80) ?? null,
          input.expected?.slice(0, 2000) ?? null,
          input.actual?.slice(0, 2000) ?? null,
        ],
      );
      if ((rowCount ?? 0) === 0) throw errors.notFound({ what: 'testing_session' });
      await tx.query('UPDATE testing.sessions SET last_active_at = now() WHERE id = $1', [
        sessionId,
      ]);
    });
  }

  // ------------------------------------------------ завершение и продолжение

  async finish(
    ctx: RequestContext,
    sessionId: string,
    result: 'unknown' | 'passed' | 'failed' = 'unknown',
  ): Promise<void> {
    this.assertEnabled();
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE testing.sessions
            SET status = 'finished', result = $2, finished_at = now(), updated_at = now(),
                last_active_at = now()
          WHERE id = $1 AND status IN ('active', 'finished')`,
        [sessionId, result],
      );
      if ((rowCount ?? 0) === 0) throw errors.notFound({ what: 'testing_session' });

      // Завершение прекращает выданные контексты: оставить их живыми значило
      // бы, что «сессия закрыта», а кабинет участника по-прежнему открыт.
      await tx.query(
        `UPDATE testing.access_contexts SET revoked_at = now()
          WHERE session_id = $1 AND revoked_at IS NULL`,
        [sessionId],
      );
      await this.audit.record(tx, {
        verb: 'testing.session.finished',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'testing_session',
        aggregateId: sessionId,
        aggregateVersion: 1,
        payload: { result },
        traceId: ctx.traceId,
        // В поток событий это не идёт: контур проверки — не предмет
        // интереса внешних подписчиков, а версия агрегата у сессии одна,
        // и вторая запись столкнулась бы с уникальностью outbox.
        publish: false,
      });
    });
  }

  async resume(ctx: RequestContext, sessionId: string): Promise<void> {
    this.assertEnabled();
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE testing.sessions
            SET status = 'active', finished_at = NULL, updated_at = now(), last_active_at = now()
          WHERE id = $1 AND status = 'finished'`,
        [sessionId],
      );
      // Убранную сессию продолжить нельзя: её данных больше нет, и «продолжение»
      // означало бы пустой кабинет без объяснения.
      if ((rowCount ?? 0) === 0) {
        throw errors.validation([
          { path: 'status', message: 'продолжить можно только завершённую сессию' },
        ]);
      }
      await this.audit.record(tx, {
        verb: 'testing.session.resumed',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'testing_session',
        aggregateId: sessionId,
        aggregateVersion: 1,
        payload: {},
        traceId: ctx.traceId,
        // В поток событий это не идёт: контур проверки — не предмет
        // интереса внешних подписчиков, а версия агрегата у сессии одна,
        // и вторая запись столкнулась бы с уникальностью outbox.
        publish: false,
      });
    });
  }

  // ------------------------------------------------------ контексты доступа

  /**
   * Открыть контекст для участника сессии или для гостя.
   *
   * Возвращает идентификатор, который вкладка кладёт в своё состояние и шлёт
   * заголовком. Ни пароля, ни токена участника при этом не существует.
   */
  async openSessionContext(
    ctx: RequestContext,
    tokenId: string | null,
    sessionId: string,
    target: { kind: 'participant'; userId: string } | { kind: 'guest' },
  ): Promise<{ contextId: string; expiresAt: string }> {
    this.assertEnabled();
    if (!ctx.userId) throw errors.unauthenticated({ stage: 'no-user' });
    if (!tokenId) {
      throw errors.forbidden({
        stage: 'context-token-unbound',
        detail: 'контекст привязывается к текущей административной сессии',
      });
    }

    const contextId = randomUUID();
    const expiresAt = new Date(Date.now() + CONTEXT_TTL_MINUTES * 60_000);

    await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM testing.sessions WHERE id = $1',
        [sessionId],
      );
      const session = rows[0];
      if (!session) throw errors.notFound({ what: 'testing_session' });
      if (session.status === 'cleaned' || session.status === 'cleaning') {
        throw errors.validation([
          { path: 'status', message: 'у убранной сессии кабинетов больше нет' },
        ]);
      }

      await tx.query(
        `INSERT INTO testing.access_contexts
           (id, kind, initiator_user_id, initiator_token_id, subject_user_id, session_id, expires_at)
         VALUES ($1, $2, $3, $4::uuid, $5, $6, $7)`,
        [
          contextId,
          target.kind,
          ctx.userId,
          tokenId,
          target.kind === 'participant' ? target.userId : null,
          sessionId,
          expiresAt,
        ],
      );
      await tx.query(`UPDATE testing.sessions SET last_active_at = now() WHERE id = $1`, [
        sessionId,
      ]);
      await this.audit.record(tx, {
        verb: 'testing.context.opened',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'testing_session',
        aggregateId: sessionId,
        aggregateVersion: 1,
        payload: {
          kind: target.kind,
          subjectUserId: target.kind === 'participant' ? target.userId : null,
        },
        traceId: ctx.traceId,
        // В поток событий это не идёт: контур проверки — не предмет
        // интереса внешних подписчиков, а версия агрегата у сессии одна,
        // и вторая запись столкнулась бы с уникальностью outbox.
        publish: false,
      });
    });

    return { contextId, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Открыть просмотр кабинета РАБОЧЕГО пользователя — только для чтения.
   *
   * Это другой режим, не тестовая сессия: данные пользователя не становятся
   * тестовыми и под уборку не попадают. Поэтому и запись контекста без
   * сессии — связь с ней означала бы участие в её уборке.
   */
  async openUserView(
    ctx: RequestContext,
    tokenId: string | null,
    subjectUserId: string,
  ): Promise<{ contextId: string; expiresAt: string }> {
    this.assertEnabled();
    if (!ctx.userId) throw errors.unauthenticated({ stage: 'no-user' });
    if (subjectUserId === ctx.userId) {
      throw errors.validation([
        { path: 'userId', message: 'свой кабинет открывается обычным входом' },
      ]);
    }
    if (!tokenId) {
      throw errors.forbidden({ stage: 'context-token-unbound' });
    }

    const contextId = randomUUID();
    const expiresAt = new Date(Date.now() + CONTEXT_TTL_MINUTES * 60_000);

    await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{ ok: boolean }>(
        `SELECT app.has_capability('identity.user.view_as') AS ok`,
      );
      if (rows[0]?.ok !== true) throw errors.forbidden({ stage: 'capability-required' });
      noteBasis(ctx.actor, { check: 'capability', code: 'identity.user.view_as' });

      await tx.query(
        `INSERT INTO testing.access_contexts
           (id, kind, initiator_user_id, initiator_token_id, subject_user_id, expires_at)
         VALUES ($1, 'readonly', $2, $3::uuid, $4, $5)`,
        [contextId, ctx.userId, tokenId, subjectUserId, expiresAt],
      );
      await this.audit.record(tx, {
        verb: 'identity.user.view_started',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'user',
        aggregateId: subjectUserId,
        aggregateVersion: 1,
        payload: { contextId },
        traceId: ctx.traceId,
        // В поток событий это не идёт: контур проверки — не предмет
        // интереса внешних подписчиков, а версия агрегата у сессии одна,
        // и вторая запись столкнулась бы с уникальностью outbox.
        publish: false,
      });
    });

    return { contextId, expiresAt: expiresAt.toISOString() };
  }

  // ------------------------------------------------------------------ уборка

  /**
   * Что уберёт очистка этой сессии.
   *
   * Показ обязателен до применения: уборка удаляет данные, и «сколько
   * именно» человек должен увидеть заранее, а не узнать из результата.
   */
  async cleanupPreview(
    ctx: RequestContext,
    sessionId: string,
  ): Promise<{ table: string; count: number; mode: 'delete' | 'mark' }[]> {
    this.assertEnabled();
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ table_name: string; n: number }>(
        `SELECT table_name, count(*)::int AS n
           FROM testing.session_objects WHERE session_id = $1
          GROUP BY table_name ORDER BY 1`,
        [sessionId],
      );
      const marked = new Set(['identity.users', 'lab.projects']);
      return rows.map((row) => ({
        table: row.table_name,
        count: row.n,
        mode: marked.has(row.table_name) ? ('mark' as const) : ('delete' as const),
      }));
    });
  }

  /**
   * Убрать данные сессии.
   *
   * ЧТО УБИРАЕТСЯ: только объекты из перечня созданного этой сессией. Не
   * таблица целиком и не «похожее на тестовое»: в одной таблице лежат и
   * подготовленное содержимое, и записи прогона.
   *
   * ПОЧЕМУ ЛЮДИ ПОМЕЧАЮТСЯ, А НЕ УДАЛЯЮТСЯ: акцепты согласий неизменяемы
   * (M002) и ссылаются на пользователя внешним ключом. Физически удалить
   * строку человека нельзя, пока это правило действует, и обходить его
   * уборка не будет.
   *
   * ПРИ НЕОДНОЗНАЧНОЙ СВЯЗИ УБОРКА ОСТАНАВЛИВАЕТСЯ. Нарушение внешнего ключа
   * означает, что на запись сессии ссылается что-то, чего в перечне нет:
   * либо перечень неполон, либо ссылается рабочая запись. И то и другое
   * разбирает человек — каскадом такое не решают.
   *
   * Повтор безопасен: уже убранное в перечне не находится, состояние
   * `clean_failed` очищается следующей попыткой.
   */
  async cleanup(
    ctx: RequestContext,
    sessionId: string,
  ): Promise<{ deleted: number; marked: number }> {
    this.assertEnabled();

    // Повторная уборка уже убранной сессии — не ошибка и не работа.
    // Отказ «не найдено» здесь врал бы: сессия на месте, просто убирать
    // нечего. Безопасный повтор владелец назвал требованием отдельно.
    const current = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        'SELECT status FROM testing.sessions WHERE id = $1',
        [sessionId],
      );
      return rows[0]?.status ?? null;
    });
    if (!current) throw errors.notFound({ what: 'testing_session' });
    if (current === 'cleaned') return { deleted: 0, marked: 0 };

    // Пометка «убирается» ставится отдельной транзакцией: она же закрывает
    // выданные контексты, чтобы во время уборки не появлялись новые данные.
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE testing.sessions
            SET status = 'cleaning', cleanup_error = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('active', 'finished', 'clean_failed')`,
        [sessionId],
      );
      if ((rowCount ?? 0) === 0) throw errors.notFound({ what: 'testing_session' });
      await tx.query(
        `UPDATE testing.access_contexts SET revoked_at = now()
          WHERE session_id = $1 AND revoked_at IS NULL`,
        [sessionId],
      );
    });

    let deleted = 0;
    let marked = 0;
    try {
      await this.db.transaction(ctx, async (tx) => {
        const order = await this.deletionOrder(tx, sessionId);
        for (const table of order) {
          const { rows } = await tx.query<{ row_id: string }>(
            'SELECT row_id FROM testing.session_objects WHERE session_id = $1 AND table_name = $2',
            [sessionId, table],
          );
          if (rows.length === 0) continue;
          const ids = rows.map((r) => r.row_id);

          if (table === 'lab.projects') {
            // Тем же приёмом, что и люди: пометка вместо удаления. У проекта
            // висят версии, участники, раунды и материалы — удаление упрётся
            // в первый внешний ключ (M131).
            const res = await tx.query<{ marked: number }>(
              'SELECT testing.cleanup_mark_projects($1) AS marked',
              [sessionId],
            );
            marked += Number(res.rows[0]?.marked ?? 0);
          } else if (table === 'identity.users') {
            // Через функцию, а не прямым UPDATE: право на пометку выдано ей,
            // а не роли приложения, и внутри она ещё раз сверяет перечень
            // сессии и происхождение записи (M130).
            const res = await tx.query<{ marked: number }>(
              'SELECT testing.cleanup_mark_users($1) AS marked',
              [sessionId],
            );
            marked += Number(res.rows[0]?.marked ?? 0);
          } else {
            const res = await tx.query(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
            deleted += res.rowCount ?? 0;
          }
        }

        await tx.query(
          `UPDATE testing.sessions
              SET status = 'cleaned', cleaned_at = now(), updated_at = now(), cleanup_error = NULL
            WHERE id = $1`,
          [sessionId],
        );
        // Перечень созданного остаётся: по нему видно, что именно убрали.
        // Сама сессия, её шаги и результат тоже остаются — владелец просил
        // сохранять минимальную запись о прогоне и факте уборки.
        await this.audit.record(tx, {
          verb: 'testing.session.cleaned',
          actorId: ctx.userId,
          actorRole: 'admin',
          aggregateType: 'testing_session',
          aggregateId: sessionId,
          aggregateVersion: 1,
          payload: { deleted, marked },
          traceId: ctx.traceId,
          // В поток событий это не идёт: контур проверки — не предмет
          // интереса внешних подписчиков, а версия агрегата у сессии одна,
          // и вторая запись столкнулась бы с уникальностью outbox.
          publish: false,
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db.transaction(ctx, (tx) =>
        tx.query(
          `UPDATE testing.sessions
              SET status = 'clean_failed', cleanup_error = $2, updated_at = now()
            WHERE id = $1`,
          [sessionId, message.slice(0, 2000)],
        ),
      );
      this.logger.warn({ msg: 'уборка сессии не выполнена', sessionId, error });
      throw errors.conflict(
        'Уборка остановлена: найдена связь, которую нельзя разорвать автоматически',
        {
          stage: 'cleanup-failed',
          detail: message.slice(0, 300),
        },
      );
    }

    return { deleted, marked };
  }

  /**
   * Порядок удаления: сначала зависимые, потом те, на кого ссылаются.
   *
   * Считается по связям базы, а не задаётся списком: список устаревает на
   * следующей миграции молча, и уборка падает у того, кто её запустил.
   */
  private async deletionOrder(tx: Tx, sessionId: string): Promise<string[]> {
    const { rows: present } = await tx.query<{ table_name: string }>(
      'SELECT DISTINCT table_name FROM testing.session_objects WHERE session_id = $1',
      [sessionId],
    );
    const tables = present.map((r) => r.table_name);
    if (tables.length <= 1) return tables;

    const { rows: links } = await tx.query<{ child: string; parent: string }>(
      `SELECT n.nspname || '.' || c.relname AS child,
              rn.nspname || '.' || rc.relname AS parent
         FROM pg_constraint co
         JOIN pg_class c ON c.oid = co.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_class rc ON rc.oid = co.confrelid
         JOIN pg_namespace rn ON rn.oid = rc.relnamespace
        WHERE co.contype = 'f'`,
    );
    const set = new Set(tables);
    const parents = new Map(tables.map((t) => [t, new Set<string>()]));
    for (const { child, parent } of links) {
      if (child === parent) continue;
      if (set.has(child) && set.has(parent)) parents.get(child)?.add(parent);
    }

    // Топологический порядок «родители последними»: дети удаляются первыми.
    const ordered: string[] = [];
    const done = new Set<string>();
    let guard = tables.length + 1;
    while (ordered.length < tables.length && guard-- > 0) {
      for (const table of tables) {
        if (done.has(table)) continue;
        const blockers = [...(parents.get(table) ?? [])].filter((p) => !done.has(p));
        // Таблица идёт в очередь, когда все, кто на неё ссылается, уже ушли.
        const referencedByPending = tables.some(
          (other) => !done.has(other) && other !== table && parents.get(other)?.has(table),
        );
        if (!referencedByPending && blockers.length >= 0) {
          ordered.push(table);
          done.add(table);
        }
      }
    }
    for (const table of tables) if (!done.has(table)) ordered.push(table);
    return ordered;
  }

  /** Завершить контекст. Отзыв немедленный: следующий запрос уже отклонён. */
  async closeContext(ctx: RequestContext, contextId: string): Promise<void> {
    this.assertEnabled();
    await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<{
        kind: string;
        subject_user_id: string | null;
        session_id: string | null;
      }>(
        `UPDATE testing.access_contexts SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
        RETURNING kind, subject_user_id, session_id`,
        [contextId],
      );
      const closed = rows[0];
      // Повторное завершение — не ошибка: вкладку закрывают дважды, и
      // ругаться на это значит пугать без причины.
      if (!closed) return;

      await this.audit.record(tx, {
        verb: closed.kind === 'readonly' ? 'identity.user.view_ended' : 'testing.context.closed',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: closed.kind === 'readonly' ? 'user' : 'testing_session',
        aggregateId:
          closed.kind === 'readonly'
            ? (closed.subject_user_id ?? contextId)
            : (closed.session_id ?? contextId),
        aggregateVersion: 1,
        payload: { contextId, kind: closed.kind },
        traceId: ctx.traceId,
        // В поток событий это не идёт: контур проверки — не предмет
        // интереса внешних подписчиков, а версия агрегата у сессии одна,
        // и вторая запись столкнулась бы с уникальностью outbox.
        publish: false,
      });
    });
  }
}
