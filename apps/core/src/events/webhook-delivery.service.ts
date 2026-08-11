import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type Tx } from '../db/unit-of-work';
import { buildEnvelope, type OutboxRow } from './publisher.service';
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

  private async lockBatch(tx: Tx): Promise<DeliveryRow[]> {
    const { rows } = await tx.query<DeliveryRow>(
      `SELECT d.id, d.endpoint_id, d.event_id, d.attempts,
              e.url, e.secret_ciphertext, e.status AS endpoint_status,
              o.id AS outbox_id, o.aggregate_type, o.aggregate_id, o.aggregate_version,
              o.event_type, o.payload_jsonb, o.nats_subject, o.schema_version,
              o.message_key, o.created_at
         FROM integration.webhook_deliveries d
         JOIN integration.webhook_endpoints e ON e.id = d.endpoint_id
         JOIN audit.outbox_events o ON o.id = d.event_id
        WHERE d.status IN ('queued', 'failed')
          AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
          AND d.attempts < $1
          AND e.status = 'active'
        ORDER BY d.created_at
        FOR UPDATE OF d SKIP LOCKED
        LIMIT $2`,
      [MAX_ATTEMPTS, getEnv().OUTBOX_BATCH_SIZE],
    );
    return rows;
  }

  private async deliverOne(traceId: string, item: DeliveryRow): Promise<boolean> {
    const envelope = buildEnvelope(toOutboxRow(item));
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      // Резолв проверяется ПЕРЕД каждой доставкой: имя, безопасное при
      // регистрации, могло начать указывать во внутреннюю сеть.
      await assertPublicDestination(item.url);

      const secret = this.crypto
        .openDirect('webhook_secrets', item.secret_ciphertext, WEBHOOK_SECRET_AAD)
        .toString('utf8');

      const response = await fetch(item.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Unicorn-Signature': signDelivery(secret, timestamp, body),
          'Unicorn-Event-Id': item.event_id,
          'Unicorn-Event-Type': item.event_type,
          'X-Request-Id': traceId,
        },
        body,
        // Внешний вызов без таймаута удерживает соединение бесконечно.
        signal: AbortSignal.timeout(deliveryTimeoutMs()),
        redirect: 'error',
      });

      if (response.ok) {
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
      await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'delivered', attempts = attempts + 1, response_code = $2,
                next_retry_at = NULL
          WHERE id = $1`,
        [id, code],
      );
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
      await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = $3, attempts = $2, response_code = $4,
                next_retry_at = CASE WHEN $3 = 'exhausted' THEN NULL
                                     ELSE now() + make_interval(secs => $5) END
          WHERE id = $1`,
        [item.id, attempts, exhausted ? 'exhausted' : 'failed', code, delaySeconds],
      );
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
