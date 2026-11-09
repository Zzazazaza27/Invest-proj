import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@fifth/contracts';
import { Database, contextOf, type RequestContext, type Tx } from '../db/unit-of-work';
import { roleFromBasis, type ActorKind, type ActorRecord } from './actor-context';
import { errors } from '../common/errors';

/**
 * Журнал событий и transactional outbox.
 *
 * Оба всегда пишутся В ТОЙ ЖЕ ТРАНЗАКЦИИ, что и доменная мутация. Иначе
 * возможны два одинаково плохих исхода: событие без факта (потребитель
 * реагирует на то, чего не произошло) и факт без события (Capital и аналитика
 * никогда о нём не узнают).
 *
 * Прямой INSERT в `audit.events` запрещён GRANT'ами: единственный путь —
 * функция `audit.app_emit_event`, которая ведёт hash-chain.
 */
@Injectable()
export class AuditRepository {
  constructor(private readonly db: Database) {}

  /**
   * Обязательная запись в журнал во время просмотра чужого кабинета (M129).
   *
   * ЗАЧЕМ ОТДЕЛЬНЫЙ ПУТЬ. В режиме просмотра `Database.transaction()`
   * отказывает — так закрыты неявные изменения. Но часть чтений обязана
   * оставлять след: раскрытие чувствительных данных без записи в журнал
   * недопустимо ни в каком режиме. Если бы запрет не имел исключения,
   * пришлось бы выбирать между «не записали» и «разрешили писать».
   *
   * ПОЧЕМУ ЭТО НЕ ДЫРА. У метода НЕТ параметра-обработчика: вызывающий не
   * может выполнить здесь произвольный запрос. Единственное, что делает этот
   * путь, — добавляет строку в журнал через ту же функцию с hash-chain.
   * Записать пользовательские данные через него нельзя не по договорённости,
   * а потому что интерфейс такого не принимает.
   *
   * В поток событий запись не публикуется: просмотр — не доменное событие, и
   * внешним подписчикам знать о нём нечего.
   */
  async recordDuringView(
    ctx: RequestContext,
    input: {
      verb: string;
      actorId: string | null;
      actorRole: string;
      subjectType: string | null;
      subjectId: string | null;
      context?: Record<string, unknown>;
    },
  ): Promise<string> {
    // Признак просмотра снимается ТОЛЬКО здесь и только для этой операции:
    // сам контекст запроса не меняется, и следующая доменная транзакция
    // по-прежнему получит отказ.
    // Смысл записи не меняется: техническое разрешение помечено отдельно (auditViewMode).
    const auditCtx: RequestContext = { ...ctx, viewOnly: false, auditViewMode: true };
    return this.db.transaction(auditCtx, (tx) =>
      this.emit(tx, {
        verb: input.verb,
        actorId: input.actorId,
        actorRole: input.actorRole,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        context: {
          ...(input.context ?? {}),
          // Запись обязана различать инициатора и того, от чьего лица шёл
          // запрос: без этого журнал отвечает «смотрел пользователь X»,
          // хотя смотрел администратор.
          viewedBy: ctx.initiatorUserId ?? null,
          viewMode: true,
        },
        traceId: ctx.traceId,
      }),
    );
  }

  /** Записать событие в append-only журнал с hash-chain. */
  async emit(
    tx: Tx,
    input: {
      verb: string;
      actorId: string | null;
      actorRole: string;
      subjectType: string | null;
      subjectId: string | null;
      context?: Record<string, unknown>;
      traceId?: string | null;
    },
  ): Promise<string> {
    const actor = buildActor(tx, input);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT audit.app_emit_event($1, $2, $3, $4, $5, $6::jsonb, $7) AS id`,
      [
        input.verb,
        actor.userId,
        actor.role,
        input.subjectType,
        input.subjectId,
        JSON.stringify({ ...(input.context ?? {}), actor }),
        input.traceId ?? null,
      ],
    );
    return rows[0]!.id;
  }

  /**
   * Положить событие в outbox для публикации в NATS.
   *
   * `aggregateVersion` обеспечивает порядок внутри агрегата и, вместе с
   * UNIQUE-ограничением, делает повторную запись того же события невозможной.
   */
  async enqueue(
    tx: Tx,
    input: {
      aggregateType: string;
      aggregateId: string;
      aggregateVersion: number;
      eventType: string;
      payload: Record<string, unknown>;
      natsSubject?: string;
      messageKey?: string;
    },
  ): Promise<string> {
    const id = uuidv7();
    const payload = JSON.stringify(input.payload);
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
          aggregate_version, message_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING
       RETURNING id`,
      [
        id,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        payload,
        input.natsSubject ?? input.eventType,
        input.aggregateVersion,
        input.messageKey ?? input.aggregateId,
      ],
    );
    if (rows[0]) return rows[0].id;

    // Вставки не было. Прежний код всё равно возвращал НОВЫЙ id — вызывающий
    // считал событие поставленным, а его не существовало. Молчаливая потеря
    // события в системе, где событие и есть доказательство действия,
    // недопустима, поэтому конфликт разбирается по существу.
    const { rows: existing } = await tx.query<{ id: string; payload_jsonb: unknown }>(
      `SELECT id, payload_jsonb FROM audit.outbox_events
        WHERE aggregate_type = $1 AND aggregate_id = $2
          AND aggregate_version = $3 AND event_type = $4`,
      [input.aggregateType, input.aggregateId, input.aggregateVersion, input.eventType],
    );
    const previous = existing[0];
    if (previous && JSON.stringify(previous.payload_jsonb) === payload) {
      // Тот же факт с тем же содержимым — законный повтор (повторная доставка
      // запроса, идемпотентность). Возвращается СУЩЕСТВУЮЩАЯ запись.
      return previous.id;
    }
    // Разное содержимое при одной версии агрегата — ошибка нумерации версий, а
    // не идемпотентность: одно из двух событий было бы потеряно.
    throw errors.conflict('Конфликт версии события агрегата', {
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      aggregateVersion: input.aggregateVersion,
      eventType: input.eventType,
    });
  }

  /**
   * Следующий номер версии агрегата для события данного типа.
   *
   * Фиксированные номера (всегда 1, всегда 2) выглядят безобидно ровно до
   * второго вызова: повторная ротация секрета или повторная публикация листинга
   * дают ту же пару (агрегат, версия), и событие конфликтует само с собой.
   * Advisory-лок на агрегат сериализует одновременные вычисления — без него два
   * параллельных действия получают один номер.
   */
  async nextAggregateVersion(
    tx: Tx,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
  ): Promise<number> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `outbox-version:${aggregateType}:${aggregateId}`,
    ]);
    const { rows } = await tx.query<{ next: string }>(
      `SELECT coalesce(max(aggregate_version), 0) + 1 AS next
         FROM audit.outbox_events
        WHERE aggregate_type = $1 AND aggregate_id = $2 AND event_type = $3`,
      [aggregateType, aggregateId, eventType],
    );
    return Number(rows[0]!.next);
  }

  /** Записать факт и событие одним вызовом — самый частый случай. */
  async record(
    tx: Tx,
    input: {
      verb: string;
      actorId: string | null;
      actorRole: string;
      aggregateType: string;
      aggregateId: string;
      aggregateVersion: number;
      payload: Record<string, unknown>;
      traceId?: string | null;
      publish?: boolean;
    },
  ): Promise<void> {
    await this.emit(tx, {
      verb: input.verb,
      actorId: input.actorId,
      actorRole: input.actorRole,
      subjectType: input.aggregateType,
      subjectId: input.aggregateId,
      context: input.payload,
      traceId: input.traceId ?? null,
    });
    if (input.publish !== false) {
      await this.enqueue(tx, {
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        aggregateVersion: input.aggregateVersion,
        eventType: input.verb,
        payload: input.payload,
      });
    }
  }

  /** Сверка целостности hash-chain. Пустой результат — цепочка цела. */
  async verifyChain(tx: Tx, from?: Date): Promise<{ eventId: string; reason: string }[]> {
    const { rows } = await tx.query<{ broken_event_id: string; reason: string }>(
      'SELECT broken_event_id, reason FROM audit.verify_event_chain($1)',
      [from ?? null],
    );
    return rows.map((r) => ({ eventId: r.broken_event_id, reason: r.reason }));
  }
}

/**
 * Автор записи журнала из контекста транзакции (блок 10).
 *
 * Аргументы `actorId`/`actorRole` остаются, но сверяются с контекстом: расхождение —
 * ошибка кода, и запись отклоняется вместе с изменением, а не пишется «как-нибудь».
 * Ключ `actor` в содержимом зарезервирован: подставить автора через данные нельзя.
 */
export function buildActor(
  tx: Tx,
  input: { verb: string; actorId: string | null; actorRole: string; context?: Record<string, unknown> },
): ActorRecord {
  const ctx = contextOf(tx);
  if (!ctx) throw new Error(`журнал: ${input.verb} пишется вне транзакции с контекстом`);
  if (input.context && Object.prototype.hasOwnProperty.call(input.context, 'actor')) {
    throw new Error(`журнал: ${input.verb} — ключ actor в содержимом зарезервирован`);
  }
  const scope = ctx.actor;
  const basis = scope?.basis ?? [];
  // Единый источник: без отмеченной проверки (или явно названного неизвестного
  // происхождения) запись не пишется — роль из аргумента вызова не подставляется.
  if (basis.length === 0) {
    throw new Error(`журнал: ${input.verb} — основание не отмечено`);
  }
  const kind: ActorKind =
    scope?.kind ??
    (ctx.userId ? 'person' : scope?.serviceAccountId ? 'service_account' : 'anonymous');

  // Сотрудник в контексте доступа: автор — он сам, учётная запись контекста — onBehalfOf.
  // Действие сотрудника владельцу учётной записи не приписывается.
  const staff = ctx.initiatorUserId ?? null;
  const userId = kind === 'person' ? (staff ?? ctx.userId) : null;
  const callerOk =
    (input.actorId ?? null) === userId || (staff !== null && input.actorId === ctx.userId);
  if (!callerOk) {
    throw new Error(`журнал: ${input.verb} — автор вызова не совпадает с контекстом запроса`);
  }
  const derived = roleFromBasis(basis, kind);
  if (derived === null && !basis.some((b) => b.check === 'unknown')) {
    throw new Error(`журнал: ${input.verb} — основание не даёт роли`);
  }
  if (derived !== null && derived !== input.actorRole) {
    throw new Error(
      `журнал: ${input.verb} — роль ${input.actorRole} не следует из пройденной проверки (${derived})`,
    );
  }
  return {
    v: 1,
    kind,
    userId,
    serviceAccountId: kind === 'service_account' ? (scope?.serviceAccountId ?? null) : null,
    role: derived ?? input.actorRole,
    basis: [...basis],
    onBehalfOf: staff ? ctx.userId : null,
    testSessionId: ctx.testSessionId ?? null,
    viewMode: ctx.viewOnly === true || ctx.auditViewMode === true,
    operationId: scope?.operationId ?? ctx.traceId,
    requestId: scope?.job ? null : ctx.traceId,
    job: scope?.job ?? null,
    initiator: scope?.initiator ?? null,
    accessContext: ctx.access ?? null,
    ...(scope?.originUnknown ? { originUnknown: true as const } : {}),
  };
}
