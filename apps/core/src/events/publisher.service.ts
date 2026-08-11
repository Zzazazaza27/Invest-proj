import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@unicorn/contracts';
import { getEnv } from '../config/env';
import { Database, type Tx } from '../db/unit-of-work';
import { NatsClient } from './nats.client';

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
export class OutboxPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPublisherService.name);
  /**
   * Кто держит аренду. Записывается в строку: по нему видно, какой экземпляр
   * завис, а не просто «строка кем-то занята».
   */
  private readonly instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly nats: NatsClient,
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
    this.timer = setInterval(() => {
      void this.runOnce();
      // Повторная постановка доставок идёт тем же тактом: событие, у которого
      // рассылка не удалась, иначе никем не подхватывается (M033).
      void this.runFanOutOnce();
    }, env.OUTBOX_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Один проход по очереди.
   *
   * @returns сколько событий опубликовано.
   */
  async runOnce(): Promise<number> {
    // Перекрытие проходов ничего не ломает (SKIP LOCKED), но множит соединения
    // на медленном брокере без всякой пользы.
    if (this.running) return 0;
    this.running = true;
    const env = getEnv();
    const traceId = `outbox-${randomUUID()}`;

    try {
      const batch = await this.db.transaction(
        { userId: null, roles: ['system'], traceId },
        async (tx) => this.lockBatch(tx, env.OUTBOX_BATCH_SIZE),
      );
      if (batch.length === 0) return 0;

      let published = 0;
      for (const event of batch) {
        try {
          const seq = await this.nats.publish(event.nats_subject, buildEnvelope(event), {
            messageId: event.id,
            messageKey: event.message_key,
          });
          await this.markPublished(traceId, event.id, seq);
          // Постановка доставок — отдельный факт с отдельной отметкой. Её
          // неудача больше не теряет задачу: строка останется в очереди
          // повторной рассылки (M033).
          if (await this.fanOutToWebhooks(traceId, event)) {
            await this.markFanOutDone(traceId, event.id);
          }
          published += 1;
        } catch (error) {
          await this.markFailed(traceId, event, error);
        }
      }
      if (published > 0) {
        this.logger.log({ msg: 'события опубликованы', count: published });
      }
      return published;
    } catch (error) {
      this.logger.error({
        msg: 'проход публикатора не выполнен',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Атомарный захват пачки в аренду.
   *
   * `FOR UPDATE SKIP LOCKED` держит строку только до конца транзакции, а
   * транзакция закрывалась ДО публикации: второй экземпляр немедленно забирал
   * те же события. Поэтому захват и отметка аренды выполняются ОДНИМ
   * выражением, а условие выборки её учитывает — строка занята до `locked_until`.
   *
   * Просроченная аренда освобождается сама: экземпляр, упавший посреди прохода,
   * не должен блокировать очередь навсегда.
   */
  private async lockBatch(tx: Tx, size: number): Promise<OutboxRow[]> {
    const { rows } = await tx.query<OutboxRow>(
      `UPDATE audit.outbox_events o
          SET locked_at = now(),
              locked_until = now() + ($3 || ' seconds')::interval,
              locked_by = $4
        WHERE o.id IN (
          SELECT id FROM audit.outbox_events
           WHERE published_at IS NULL
             AND next_attempt_at <= now()
             AND attempts < $2
             AND (locked_until IS NULL OR locked_until < now())
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $1)
      RETURNING o.id, o.aggregate_type, o.aggregate_id, o.aggregate_version, o.event_type,
                o.payload_jsonb, o.nats_subject, o.schema_version, o.message_key,
                o.attempts, o.created_at`,
      [size, MAX_ATTEMPTS, LEASE_SECONDS, this.instanceId],
    );
    return rows;
  }

  /**
   * Повторная постановка доставок для уже опубликованных событий.
   *
   * Очередь, которой раньше не существовало: событие, опубликованное в брокер,
   * но не разосланное подписчикам, прежде не выбиралось ничем и терялось молча.
   */
  async runFanOutOnce(): Promise<number> {
    if (!getEnv().DATABASE_URL_APP_INTEGRATION) return 0;
    const traceId = `fanout-${randomUUID()}`;

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

  private async markPublished(traceId: string, id: string, seq: number): Promise<void> {
    await this.db.transaction({ userId: null, roles: ['system'], traceId }, async (tx) => {
      await tx.query(
        `UPDATE audit.outbox_events
            SET published_at = now(), locked_at = NULL, last_error = NULL
          WHERE id = $1 AND published_at IS NULL`,
        [id],
      );
    });
    this.logger.debug?.({ msg: 'событие опубликовано', id, seq });
  }

  /**
   * Отметка неудачи с экспоненциальной задержкой.
   *
   * Текст ошибки сохраняется во внутреннее поле и наружу не уходит: это
   * диагностика для оператора, а не часть контракта.
   */
  private async markFailed(traceId: string, event: OutboxRow, error: unknown): Promise<void> {
    const attempts = event.attempts + 1;
    const delaySeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);
    const message = error instanceof Error ? error.message : String(error);

    await this.db.transaction({ userId: null, roles: ['system'], traceId }, async (tx) => {
      await tx.query(
        `UPDATE audit.outbox_events
            SET attempts = $2,
                next_attempt_at = now() + make_interval(secs => $3),
                locked_at = NULL,
                last_error = left($4, 500)
          WHERE id = $1`,
        [event.id, attempts, delaySeconds, message],
      );
    });

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
        error: error instanceof Error ? error.message : String(error),
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
