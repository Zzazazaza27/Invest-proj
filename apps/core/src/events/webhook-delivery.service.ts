import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type Tx } from '../db/unit-of-work';
import { buildEnvelope, type OutboxRow } from './publisher.service';
import { absoluteDeadlineMs, postPinned } from './pinned-fetch';
import {
  assertPublicDestination,
  deliveryTimeoutMs,
  signDelivery,
  WEBHOOK_SECRET_AAD,
} from './webhooks.service';

/**
 * Доставка событий подписчикам.
 *
 * Отдельный цикл от публикации в брокер, и это принципиально: недоступный
 * подписчик не должен задерживать публикацию для всех остальных. Событие уже
 * записано и опубликовано — доставка лишь догоняет.
 *
 * Каждая доставка подписана HMAC с меткой времени, чтобы получатель мог
 * отличить нашу доставку от чужой и отвергнуть переигранную. Попытки
 * ограничены: бесконечные ретраи к отвалившемуся потребителю — это DoS против
 * собственной инфраструктуры, а не забота о доставке.
 */
@Injectable()
export class WebhookDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  /** Кто держит аренду: по нему видно, какой экземпляр завис. */
  private readonly instanceId = `${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    if (!env.DATABASE_URL_APP_INTEGRATION) {
      this.logger.warn({ msg: 'доставка вебхуков выключена: интеграционный контур не настроен' });
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce();
    }, env.WEBHOOK_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Один проход очереди доставок. Возвращает число доставленных. */
  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    const traceId = `webhooks-${randomUUID()}`;

    try {
      const batch = await this.db.asServiceRole('app_integration', { traceId }, async (tx) =>
        this.lockBatch(tx),
      );
      if (batch.length === 0) return 0;

      let delivered = 0;
      for (const item of batch) {
        // Аренда продлевается ПЕРЕД каждой доставкой, а не берётся одна на всю
        // пачку. Прежняя схема была арифметически несостоятельна: до
        // OUTBOX_BATCH_SIZE строк (по умолчанию 50) получали общую аренду в
        // DELIVERY_LEASE_SECONDS, а отправлялись последовательно, каждая до
        // нескольких секунд. К концу пачки аренда давно истекала, другой
        // экземпляр забирал те же строки и слал вебхук ВТОРОЙ раз — а побочный
        // эффект у получателя настоящий: списание, сделка, запись в CRM
        // (SEC-06).
        if (!(await this.renewLease(traceId, item.id))) {
          this.logger.warn({
            msg: 'аренда доставки потеряна, отправка пропущена',
            deliveryId: item.id,
            eventType: item.event_type,
          });
          continue;
        }
        const ok = await this.deliverOne(traceId, item);
        if (ok) delivered += 1;
      }
      return delivered;
    } catch (error) {
      this.logger.error({
        msg: 'проход доставки вебхуков не выполнен',
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Атомарный захват доставок в аренду.
   *
   * `FOR UPDATE SKIP LOCKED` отпускал строку вместе с транзакцией — то есть ДО
   * самого HTTP-запроса, и второй экземпляр отправлял ту же доставку
   * одновременно. Заголовок `Unicorn-Event-Id` помогает получателю
   * дедуплицировать, но перекладывать гарантию на чужую систему нельзя:
   * побочный эффект у неё настоящий (SEC-19).
   *
   * Захват и отметка аренды — одним выражением; условие выборки её учитывает.
   */
  private async lockBatch(tx: Tx): Promise<DeliveryRow[]> {
    // Шаг 1: захват. Одно выражение — иначе между выбором и отметкой аренды
    // остаётся окно, в которое ту же строку берёт второй экземпляр.
    const { rows: claimed } = await tx.query<{ id: string }>(
      `UPDATE integration.webhook_deliveries d
          SET locked_until = now() + ($3 || ' seconds')::interval,
              locked_by = $4
        WHERE d.id IN (
          SELECT d2.id
            FROM integration.webhook_deliveries d2
            JOIN integration.webhook_endpoints e2 ON e2.id = d2.endpoint_id
           WHERE d2.status IN ('queued', 'failed')
             AND (d2.next_retry_at IS NULL OR d2.next_retry_at <= now())
             AND d2.attempts < $1
             AND e2.status = 'active'
             AND (d2.locked_until IS NULL OR d2.locked_until < now())
           ORDER BY d2.created_at
           FOR UPDATE OF d2 SKIP LOCKED
           LIMIT $2)
      RETURNING d.id`,
      [MAX_ATTEMPTS, getEnv().OUTBOX_BATCH_SIZE, deliveryLeaseSeconds(), this.instanceId],
    );
    if (claimed.length === 0) return [];

    // Шаг 2: данные для доставки. Отдельным запросом, а не подзапросами в
    // RETURNING: строки уже наши по аренде, и читать их можно спокойно.
    const { rows } = await tx.query<DeliveryRow>(
      `SELECT d.id, d.endpoint_id, d.event_id, d.attempts,
              e.url, e.secret_ciphertext, e.status AS endpoint_status,
              o.id AS outbox_id, o.aggregate_type, o.aggregate_id, o.aggregate_version,
              o.event_type, o.payload_jsonb, o.nats_subject, o.schema_version,
              o.message_key, o.created_at
         FROM integration.webhook_deliveries d
         JOIN integration.webhook_endpoints e ON e.id = d.endpoint_id
         JOIN audit.outbox_events o ON o.id = d.event_id
        WHERE d.id = ANY($1::uuid[])
        ORDER BY d.created_at`,
      [claimed.map((row) => row.id)],
    );
    return rows;
  }

  /**
   * Продлить аренду ровно этой строки, оставаясь её владельцем.
   *
   * Возвращает `false`, если аренда уже не наша: истекла и её перехватили, либо
   * строку забрал другой экземпляр. Тогда отправлять НЕЛЬЗЯ — она уже в работе
   * у другого, и вторая отправка означала бы повторный побочный эффект.
   *
   * Условие `locked_by = $2` — это ограждение. Идентификатор экземпляра свой у
   * каждого процесса, поэтому перехват строки чужим экземпляром обнуляет наше
   * право на неё, даже если по времени аренда ещё выглядит живой.
   */
  private async renewLease(traceId: string, id: string): Promise<boolean> {
    return this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET locked_until = now() + ($3 || ' seconds')::interval
          WHERE id = $1 AND locked_by = $2 AND locked_until > now()`,
        [id, this.instanceId, deliveryLeaseSeconds()],
      );
      return (rowCount ?? 0) === 1;
    });
  }

  private async deliverOne(traceId: string, item: DeliveryRow): Promise<boolean> {
    const envelope = buildEnvelope(toOutboxRow(item));
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      // Резолв проверяется ПЕРЕД каждой доставкой: имя, безопасное при
      // регистрации, могло начать указывать во внутреннюю сеть. Проверенные
      // адреса используются дальше как есть — повторного разрешения имени
      // не происходит (DNS rebinding, SEC-05).
      const allowedAddresses = await assertPublicDestination(item.url);

      const secret = this.crypto
        .openDirect('webhook_secrets', item.secret_ciphertext, WEBHOOK_SECRET_AAD)
        .toString('utf8');

      const response = await postPinned(item.url, {
        allowedAddresses,
        headers: {
          'Content-Type': 'application/json',
          'Unicorn-Signature': signDelivery(secret, timestamp, body),
          'Unicorn-Event-Id': item.event_id,
          'Unicorn-Event-Type': item.event_type,
          'X-Request-Id': traceId,
        },
        body,
        // Внешний вызов без таймаута удерживает соединение бесконечно.
        timeoutMs: deliveryTimeoutMs(),
      });

      // Перенаправления не выполняются: 3xx считается неуспехом доставки, а не
      // приглашением сходить по адресу из Location.
      if (response.status >= 200 && response.status < 300) {
        await this.markDelivered(traceId, item.id, response.status);
        return true;
      }
      await this.markFailed(traceId, item, `HTTP ${response.status}`, response.status);
      return false;
    } catch (error) {
      await this.markFailed(
        traceId,
        item,
        error instanceof Error ? error.message : String(error),
        null,
      );
      return false;
    }
  }

  private async markDelivered(traceId: string, id: string, code: number): Promise<void> {
    await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      // Результат пишется, только пока строка НАША. Без этого условия
      // экземпляр, у которого аренду уже перехватили, затирал бы итог того,
      // кто отправляет её сейчас (SEC-06).
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'delivered', attempts = attempts + 1, response_code = $2,
                next_retry_at = NULL
          WHERE id = $1 AND locked_by = $3`,
        [id, code, this.instanceId],
      );
      if ((rowCount ?? 0) === 0) {
        this.logger.warn({ msg: 'итог доставки не записан: аренда уже не наша', deliveryId: id });
      }
    });
  }

  private async markFailed(
    traceId: string,
    item: DeliveryRow,
    reason: string,
    code: number | null,
  ): Promise<void> {
    const attempts = item.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);

    await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = $3, attempts = $2, response_code = $4,
                next_retry_at = CASE WHEN $3 = 'exhausted' THEN NULL
                                     ELSE now() + make_interval(secs => $5) END
          WHERE id = $1 AND locked_by = $6`,
        [
          item.id,
          attempts,
          exhausted ? 'exhausted' : 'failed',
          code,
          delaySeconds,
          this.instanceId,
        ],
      );
      if ((rowCount ?? 0) === 0) {
        this.logger.warn({
          msg: 'отказ доставки не записан: аренда уже не наша',
          deliveryId: item.id,
        });
      }
    });

    this.logger[exhausted ? 'error' : 'warn']({
      msg: exhausted ? 'доставка вебхука прекращена' : 'доставка вебхука отложена',
      deliveryId: item.id,
      eventType: item.event_type,
      attempts,
      // Причина — без тела ответа получателя: оно чужое и может содержать что угодно.
      reason: reason.slice(0, 200),
    });
  }
}

/**
 * Срок аренды ОДНОЙ доставки.
 *
 * Считается от предельной длительности самой доставки, а не назначается числом.
 * Прежняя константа в 60 секунд была взята «с запасом от таймаута», но запас
 * считался от ОДНОГО запроса, тогда как под общей арендой шла вся пачка. Такой
 * запас не запас: при пятидесяти строках он исчерпывался на первых нескольких.
 *
 * Теперь аренда продлевается перед каждой доставкой (`renewLease`), и её срок
 * обязан покрывать ровно одну доставку с её абсолютным предельным сроком плюс
 * поле на запись результата.
 */
export function deliveryLeaseSeconds(): number {
  return (
    Math.ceil(absoluteDeadlineMs({ timeoutMs: deliveryTimeoutMs() }) / 1000) + LEASE_MARGIN_SECONDS
  );
}

/**
 * Поле сверх предельного срока доставки: время на запись результата и на
 * расхождение часов между экземплярами.
 */
const LEASE_MARGIN_SECONDS = 10;

const MAX_ATTEMPTS = 8;
const MAX_BACKOFF_SECONDS = 3600;

interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  attempts: number;
  url: string;
  secret_ciphertext: Buffer;
  endpoint_status: string;
  outbox_id: string;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: string;
  event_type: string;
  payload_jsonb: Record<string, unknown>;
  nats_subject: string;
  schema_version: number;
  message_key: string;
  created_at: Date;
}

function toOutboxRow(item: DeliveryRow): OutboxRow {
  return {
    id: item.outbox_id,
    aggregate_type: item.aggregate_type,
    aggregate_id: item.aggregate_id,
    aggregate_version: item.aggregate_version,
    event_type: item.event_type,
    payload_jsonb: item.payload_jsonb,
    nats_subject: item.nats_subject,
    schema_version: item.schema_version,
    message_key: item.message_key,
    attempts: item.attempts,
    created_at: item.created_at,
  };
}
