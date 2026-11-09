import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@fifth/contracts';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { resultOf } from '../background/job';
import { claimLeases, completeUnderLease, renewLease, type Lease } from '../background/lease';
import { getEnv } from '../config/env';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { AvailabilityService } from '../availability/availability.service';
import { brokerBreaker } from './events-health';
import { NatsClient } from './nats.client';

const OUTBOX = 'audit.outbox_events';
const SYSTEM = (traceId: string): RequestContext => ({ userId: null, roles: ['system'], traceId });

/**
 * Публикатор transactional outbox.
 *
 * Доменная операция пишет факт и событие ОДНОЙ транзакцией (см.
 * `AuditRepository`), а наружу событие уходит отсюда. Разделение обязательно:
 * публикация в брокер внутри бизнес-транзакции означала бы либо откат сделки
 * из-за недоступного брокера, либо опубликованное событие о том, чего не
 * произошло.
 *
 * Три свойства, ради которых цикл выглядит именно так:
 *
 *  - `FOR UPDATE SKIP LOCKED` — несколько экземпляров core разбирают очередь
 *    параллельно и не берут одну строку дважды;
 *  - `msgID` в JetStream — повтор после сбоя не создаёт второго сообщения у
 *    потребителя, даже если отметка в БД не успела записаться;
 *  - экспоненциальная задержка и предел попыток — отвалившийся брокер не
 *    превращает публикатор в источник нагрузки на самого себя.
 */
@Injectable()
export class OutboxPublisherService implements OnModuleInit {
  private readonly logger = new Logger(OutboxPublisherService.name);

  constructor(
    private readonly db: Database,
    private readonly nats: NatsClient,
    private readonly jobs: BackgroundJobsService,
    @Optional() private readonly availability?: AvailabilityService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    if (!this.nats.enabled) {
      // Явная запись в лог вместо тихого простоя: «события не уходят» —
      // состояние, которое обязано быть видно.
      this.logger.warn({
        msg: 'публикация событий выключена: NATS_URL не задан, события копятся в outbox',
      });
      return;
    }
    // Стрим проверяется ОДИН раз при старте. Ядро не создаёт его (право на
    // управление стримом — это и право стереть историю событий), но обязано
    // громко сказать, если публиковать некуда: без этой проверки события
    // молча копились в outbox, и обнаружилось это только сквозным прогоном.
    void this.nats.streamStatus().then((status) => {
      if (status) {
        this.logger.log({
          msg: 'стрим событий доступен',
          stream: status.stream,
          messages: status.messages,
          subjects: status.subjects.length,
        });
      }
    });

    // Запуск, выключатель, остановку и перехват ошибок даёт общая оболочка
    // (блок 1). Падение ядра от неперехваченного фонового прохода (2026-09-22,
    // гибернация) там закрыто для всех задач сразу. Аренда строк — своя,
    // прежняя; на общую с id захвата переходит при доработке (1.3.6).
    this.jobs.register({
      name: 'outbox.publish',
      intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      idle: { maxMs: env.QUEUE_IDLE_MAX_MS, wake: 'outbox' },
      coordination: 'local',
      run: async ({ signal }) => resultOf(await this.runOnce(signal)),
    });
    // Повторная постановка доставок: событие, у которого рассылка не удалась,
    // иначе никем не подхватывается (M033).
    this.jobs.register({
      name: 'outbox.fanout',
      intervalMs: env.OUTBOX_POLL_INTERVAL_MS,
      // Повторная рассылка — по отказам прошлых: новых событий не ждёт, просыпается по паузе.
      idle: { maxMs: env.QUEUE_IDLE_MAX_MS },
      coordination: 'local',
      run: async ({ signal }) => resultOf(await this.runFanOutOnce(signal)),
    });
  }

  /**
   * Один проход по очереди.
   *
   * Отказ прохода целиком (БД, захват пачки) бросается наружу: оболочка
   * записывает его как неудачу. Отказ одной записи — её отложенный повтор.
   *
   * @param signal прерывание остановкой: следующую запись пачки не берём, уже
   *   начатую доводим. Оставшиеся строки освободятся по сроку аренды.
   * @returns сколько событий опубликовано.
   */
  async runOnce(signal?: AbortSignal): Promise<number> {
    const env = getEnv();
    const traceId = `outbox-${randomUUID()}`;
    // Брокер недоступен: пачку не берём вовсе, события ждут в outbox без расхода попыток.
    if (Date.now() < this.pausedUntil) return 0;
    // Ручной запрет группы «События» (4.11): публикация стоит, события копятся. Отказ
    // доставки вебхуков публикацию не останавливает — контуры независимы.
    if (this.availability && (await this.availability.restrictionOf('events'))) return 0;

    const { batch, leases } = await this.db.transaction(SYSTEM(traceId), async (tx) =>
      this.lockBatch(tx, env.OUTBOX_BATCH_SIZE),
    );
    if (batch.length === 0) return 0;

    let published = 0;
    for (let i = 0; i < batch.length; i += 1) {
      const event = batch[i]!;
      const lease = leases.get(event.id)!;
      const rest = () => batch.slice(i).map((e) => leases.get(e.id)!);
      if (signal?.aborted) {
        await this.release(traceId, rest());
        break;
      }
      // Аренда наша и живая — иначе проход прекращается целиком, а не только без отметки:
      // строки уже у другого исполнителя, публиковать за него нельзя.
      if (!(await this.renew(traceId, lease))) {
        this.logger.warn({ msg: 'аренда события потеряна, проход остановлен', id: event.id });
        await this.release(traceId, rest().slice(1));
        break;
      }
      let seq: number;
      try {
        seq = await this.nats.publish(event.nats_subject, buildEnvelope(event), {
          // Идентификатор события — и при повторе после неизвестного исхода: дубль
          // отсекает окно дедупликации стрима.
          messageId: event.id,
          messageKey: event.message_key,
        });
      } catch (error) {
        const kind = this.nats.classifyPublishFailure(error);
        if (kind === 'event') {
          if (!(await this.markFailed(traceId, lease, event, error))) {
            await this.release(traceId, rest().slice(1));
            break;
          }
          continue;
        }
        // Брокер недоступен или подтверждение потеряно: попытку не засчитываем, событие и
        // оставшаяся пачка освобождаются, публикатор встаёт на паузу.
        brokerBreaker().record('write', false);
        this.pause(kind, event.id, error);
        await this.release(traceId, rest());
        break;
      }
      this.resume();
      brokerBreaker().record('write', true);
      if (!(await this.markPublished(traceId, lease, seq))) {
        // Опубликовано, но захват уже не наш: отметку поставит новый владелец — его
        // повтор с тем же messageId дубля не даст. Дальше не идём.
        this.logger.warn({ msg: 'аренда потеряна после публикации', id: event.id });
        await this.release(traceId, rest().slice(1));
        break;
      }
      // Постановка доставок — отдельный факт с отдельной отметкой. Её
      // неудача больше не теряет задачу: строка останется в очереди
      // повторной рассылки (M033).
      if (await this.fanOutToWebhooks(traceId, event)) {
        await this.markFanOutDone(traceId, event.id);
      }
      published += 1;
    }
    if (published > 0) {
      this.logger.log({ msg: 'события опубликованы', count: published });
    }
    return published;
  }

  /** Пауза при недоступном брокере: от 5 с, вдвое за каждый отказ, не дольше 5 минут. */
  private pausedUntil = 0;
  private pauseMs = 0;

  private pause(kind: 'broker' | 'unknown' | 'blocked', id: string, error: unknown): void {
    this.pauseMs = Math.min(Math.max(this.pauseMs * 2, 5_000), MAX_BACKOFF_SECONDS * 1000);
    this.pausedUntil = Date.now() + this.pauseMs;
    const detail = {
      id,
      pauseSeconds: Math.round(this.pauseMs / 1000),
      code: String((error as { code?: unknown })?.code ?? ''),
      error,
    };
    if (kind === 'blocked') {
      // Права, вход, конфигурация или нераспознанный отказ: событие не виновато, но и само
      // не пройдёт — нужен человек. Ошибкой, чтобы сигнал не потерялся среди предупреждений.
      this.logger.error({
        msg: 'публикация событий заблокирована отказом брокера не по вине события: попытки не расходуются',
        ...detail,
      });
      return;
    }
    this.logger.warn({
      msg:
        kind === 'broker'
          ? 'брокер событий недоступен: публикация на паузе, попытки событий не расходуются'
          : 'подтверждение публикации не получено: событие повторится с тем же идентификатором',
      ...detail,
    });
  }

  private resume(): void {
    if (this.pauseMs > 0) this.logger.log({ msg: 'брокер событий снова принимает публикацию' });
    this.pauseMs = 0;
    this.pausedUntil = 0;
  }

  /**
   * Захват пачки общим модулем аренды (M160): новый идентификатор на каждый захват.
   * Строки, взятые прежней версией (`locked_until`), не берутся до истечения её срока.
   */
  private async lockBatch(
    tx: Tx,
    size: number,
  ): Promise<{ batch: OutboxRow[]; leases: Map<string, Lease> }> {
    const claimed = await claimLeases(tx, {
      table: OUTBOX,
      where: `published_at IS NULL AND next_attempt_at <= now() AND attempts < $1
              AND (locked_until IS NULL OR locked_until < now())`,
      params: [MAX_ATTEMPTS],
      orderBy: 'created_at',
      limit: size,
      seconds: LEASE_SECONDS,
    });
    if (claimed.length === 0) return { batch: [], leases: new Map() };
    const { rows } = await tx.query<OutboxRow>(
      `SELECT id, aggregate_type, aggregate_id, aggregate_version, event_type, payload_jsonb,
              nats_subject, schema_version, message_key, attempts, created_at
         FROM audit.outbox_events WHERE id = ANY($1::uuid[]) ORDER BY created_at`,
      [claimed.map((l) => l.id)],
    );
    return { batch: rows, leases: new Map(claimed.map((l) => [l.id, l])) };
  }

  private renew(traceId: string, lease: Lease): Promise<boolean> {
    return this.db.transaction(SYSTEM(traceId), (tx) =>
      renewLease(tx, { table: OUTBOX, lease, seconds: LEASE_SECONDS }),
    );
  }

  /** Вернуть свои незавершённые строки в очередь сразу, не дожидаясь срока аренды. */
  private async release(traceId: string, leases: Lease[]): Promise<void> {
    if (leases.length === 0) return;
    await this.db.transaction(SYSTEM(traceId), async (tx) => {
      await tx.query(
        `UPDATE audit.outbox_events SET lease_id = NULL, lease_until = NULL
          WHERE id = ANY($1::uuid[]) AND lease_id = ANY($2::uuid[])`,
        [leases.map((l) => l.id), leases.map((l) => l.leaseId)],
      );
    });
  }

  /**
   * Повторная постановка доставок для уже опубликованных событий.
   *
   * Очередь, которой раньше не существовало: событие, опубликованное в брокер,
   * но не разосланное подписчикам, прежде не выбиралось ничем и терялось молча.
   */
  async runFanOutOnce(signal?: AbortSignal): Promise<number> {
    if (!getEnv().DATABASE_URL_APP_INTEGRATION) return 0;
    // Отказ прохода бросается наружу: события остаются в очереди, оболочка
    // записывает неудачу, следующий проход пробует снова.
    return this.fanOutPass(`fanout-${randomUUID()}`, signal);
  }

  private async fanOutPass(traceId: string, signal?: AbortSignal): Promise<number> {
    const pending = await this.db.transaction(
      { userId: null, roles: ['system'], traceId },
      async (tx) => {
        const { rows } = await tx.query<OutboxRow>(
          `SELECT id, aggregate_type, aggregate_id, aggregate_version, event_type,
                  payload_jsonb, nats_subject, schema_version, message_key, attempts, created_at
             FROM audit.outbox_events
            WHERE published_at IS NOT NULL AND fanout_completed_at IS NULL
            ORDER BY published_at
            LIMIT $1`,
          [getEnv().OUTBOX_BATCH_SIZE],
        );
        return rows;
      },
    );

    let done = 0;
    for (const event of pending) {
      if (signal?.aborted) break;
      if (await this.fanOutToWebhooks(traceId, event)) {
        await this.markFanOutDone(traceId, event.id);
        done += 1;
      }
    }
    if (done > 0) this.logger.log({ msg: 'доставки поставлены повторно', count: done });
    return done;
  }

  private async markFanOutDone(traceId: string, id: string): Promise<void> {
    await this.db.transaction({ userId: null, roles: ['system'], traceId }, async (tx) => {
      await tx.query(`UPDATE audit.outbox_events SET fanout_completed_at = now() WHERE id = $1`, [
        id,
      ]);
    });
  }

  /** «Опубликовано» — только при текущем захвате (M160). `false` — захват уже не наш. */
  private async markPublished(traceId: string, lease: Lease, seq: number): Promise<boolean> {
    const done = await this.db.transaction(SYSTEM(traceId), (tx) =>
      completeUnderLease(tx, {
        table: OUTBOX,
        lease,
        set: 'published_at = coalesce(published_at, now()), locked_at = NULL, last_error = NULL',
      }),
    );
    if (done) this.logger.debug?.({ msg: 'событие опубликовано', id: lease.id, seq });
    return done;
  }

  /**
   * Отметка неудачи самого события с экспоненциальной задержкой — под текущим захватом.
   * Отказ брокера сюда не попадает: он попыток не расходует.
   *
   * Текст ошибки сохраняется во внутреннее поле и наружу не уходит: это
   * диагностика для оператора, а не часть контракта.
   */
  private async markFailed(
    traceId: string,
    lease: Lease,
    event: OutboxRow,
    error: unknown,
  ): Promise<boolean> {
    const attempts = event.attempts + 1;
    const delaySeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
    const message = error instanceof Error ? error.message : String(error);

    const done = await this.db.transaction(SYSTEM(traceId), (tx) =>
      completeUnderLease(tx, {
        table: OUTBOX,
        lease,
        set: `attempts = $1, next_attempt_at = now() + make_interval(secs => $2),
              locked_at = NULL, last_error = left($3, 500)`,
        params: [attempts, delaySeconds, message],
      }),
    );
    if (!done) return false;

    if (attempts >= MAX_ATTEMPTS) {
      // Исчерпание попыток — инцидент, а не рутина: событие уже произошло, а
      // потребители о нём не узнали.
      this.logger.error({
        msg: 'событие не опубликовано после предела попыток',
        id: event.id,
        eventType: event.event_type,
        attempts,
      });
    } else {
      this.logger.warn({
        msg: 'публикация события отложена',
        id: event.id,
        attempts,
        delaySeconds,
      });
    }
    return true;
  }

  /**
   * Постановка доставок подписчикам.
   *
   * Ставится только то, на что подписались явно: подписка на `lab.*` не
   * означает согласия получать события регулируемого контура. Дубли исключены
   * ограничением (endpoint_id, event_id).
   */
  private async fanOutToWebhooks(traceId: string, event: OutboxRow): Promise<boolean> {
    // Контур интеграции не настроен — рассылать некому, и это законченное
    // состояние, а не отложенная работа.
    if (!getEnv().DATABASE_URL_APP_INTEGRATION) return true;
    try {
      await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
        await tx.query(
          `INSERT INTO integration.webhook_deliveries (id, endpoint_id, event_id)
           SELECT public.uuid_generate_v7(), e.id, $1
             FROM integration.webhook_endpoints e
            WHERE e.status = 'active' AND $2 = ANY(e.subscribed_verbs)
           ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
          [event.id, event.event_type],
        );
      });
      return true;
    } catch (error) {
      // Неудача постановки не отменяет состоявшуюся публикацию в брокер, но и
      // не теряется: `fanout_completed_at` остаётся пустым, и событие заберёт
      // проход повторной рассылки. Прежний комментарий обещал подхват
      // «следующим проходом по неопубликованным» — тот проход такие строки не
      // видит вовсе, и доставки терялись безвозвратно (CODE-04).
      this.logger.error({
        msg: 'постановка доставок вебхуков не выполнена, событие в очереди повтора',
        id: event.id,
        error,
      });
      return false;
    }
  }
}

/** Предел попыток публикации. Дальше — DLQ и разбор человеком. */
const MAX_ATTEMPTS = 10;

/**
 * Срок аренды строки. Больше самого долгого прохода публикации и меньше
 * интервала, за который недоступность брокера становится заметной: слишком
 * короткая аренда отдаст строку второму экземпляру во время работы первого,
 * слишком длинная задержит повтор после падения.
 */
const LEASE_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 300;

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  event_type: string;
  payload_jsonb: Record<string, unknown>;
  nats_subject: string;
  schema_version: number;
  message_key: string;
  attempts: number;
  created_at: Date;
}

/**
 * Конверт события — публичный контракт для Capital и медиаконтура.
 * Форма одинакова для всех verb'ов: потребитель разбирает конверт один раз.
 */
export function buildEnvelope(event: OutboxRow): Record<string, unknown> {
  return {
    eventId: event.id,
    verb: event.event_type,
    schemaVersion: event.schema_version,
    occurredAt: event.created_at.toISOString(),
    aggregateType: event.aggregate_type,
    aggregateId: event.aggregate_id,
    // BIGINT приходит строкой (драйвер настроен так намеренно), а в контракте
    // это число: версии агрегата не достигают предела точности JS.
    aggregateVersion: Number(event.aggregate_version),
    traceId: null,
    payload: event.payload_jsonb,
  };
}

/** Идентификатор доставки. Вынесен, чтобы не тянуть uuidv7 по всему модулю. */
export function newDeliveryId(): string {
  return uuidv7();
}
