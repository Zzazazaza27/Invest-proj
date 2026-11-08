import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { resultOf } from '../background/job';
import { getEnv } from '../config/env';
import { CryptoService, isKmsUnavailable } from '../crypto/crypto.service';
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
export class WebhookDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  /** Кто держит аренду: по нему видно, какой экземпляр завис. */

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly jobs: BackgroundJobsService,
  ) {}

  onModuleInit(): void {
    const env = getEnv();
    if (!env.DATABASE_URL_APP_INTEGRATION) {
      this.logger.warn({ msg: 'доставка вебхуков выключена: интеграционный контур не настроен' });
      return;
    }
    // Запуск, остановку и перехват ошибок даёт общая оболочка (блок 1);
    // аренда доставок — своя, прежняя, до доработки по 1.3.6.
    this.jobs.register({
      name: 'webhooks.deliver',
      intervalMs: env.WEBHOOK_POLL_INTERVAL_MS,
      coordination: 'local',
      run: async ({ signal }) => resultOf(await this.runOnce(signal)),
    });
  }

  /**
   * Один проход очереди доставок. Возвращает число доставленных.
   *
   * Отказ прохода целиком бросается наружу — его записывает оболочка. После
   * прерывания (`signal`) следующая доставка не начинается: внешний запрос —
   * самостоятельное действие с настоящим побочным эффектом у получателя.
   */
  async runOnce(signal?: AbortSignal): Promise<number> {
    const traceId = `webhooks-${randomUUID()}`;

    const batch = await this.db.asServiceRole('app_integration', { traceId }, async (tx) =>
      this.lockBatch(tx),
    );
    if (batch.length === 0) return 0;

    let delivered = 0;
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i]!;
      if (signal?.aborted) {
        await this.release(traceId, batch.slice(i));
        break;
      }
      // Аренда продлевается ПЕРЕД каждой доставкой, а не берётся одна на всю
      // пачку. Прежняя схема была арифметически несостоятельна: до
      // OUTBOX_BATCH_SIZE строк (по умолчанию 50) получали общую аренду в
      // DELIVERY_LEASE_SECONDS, а отправлялись последовательно, каждая до
      // нескольких секунд. К концу пачки аренда давно истекала, другой
      // экземпляр забирал те же строки и слал вебхук ВТОРОЙ раз — а побочный
      // эффект у получателя настоящий: списание, сделка, запись в CRM
      // (SEC-06).
      if (!(await this.renewLease(traceId, item))) {
        // Захват уже не наш: дальше не идём вовсе — пачка могла уйти другому исполнителю.
        this.logger.warn({
          msg: 'аренда доставки потеряна, проход остановлен',
          deliveryId: item.id,
          eventType: item.event_type,
        });
        await this.release(traceId, batch.slice(i + 1));
        break;
      }
      const ok = await this.deliverOne(traceId, item);
      if (ok) delivered += 1;
    }
    return delivered;
  }

  /** Вернуть свои незавершённые доставки в очередь сразу, не дожидаясь срока аренды. */
  private async release(traceId: string, items: DeliveryRow[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      await tx.query(
        `UPDATE integration.webhook_deliveries SET lease_id = NULL, lease_until = NULL
          WHERE id = ANY($1::uuid[]) AND lease_id = ANY($2::uuid[])`,
        [items.map((x) => x.id), items.map((x) => x.lease_id)],
      );
    });
  }

  /**
   * Атомарный захват доставок в аренду.
   *
   * `FOR UPDATE SKIP LOCKED` отпускал строку вместе с транзакцией — то есть ДО
   * самого HTTP-запроса, и второй экземпляр отправлял ту же доставку
   * одновременно. Заголовок `Fifth-Event-Id` помогает получателю
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
          SET lease_id = $4::uuid,
              lease_until = now() + make_interval(secs => $3)
        WHERE d.id IN (
          SELECT d2.id
            FROM integration.webhook_deliveries d2
            JOIN integration.webhook_endpoints e2 ON e2.id = d2.endpoint_id
           WHERE d2.status IN ('queued', 'failed')
             AND (d2.next_retry_at IS NULL OR d2.next_retry_at <= now())
             AND d2.attempts < $1
             AND e2.status = 'active'
             AND (d2.lease_until IS NULL OR d2.lease_until < now())
             AND (d2.locked_until IS NULL OR d2.locked_until < now())
           ORDER BY d2.created_at
           FOR UPDATE OF d2 SKIP LOCKED
           LIMIT $2)
      RETURNING d.id`,
      [MAX_ATTEMPTS, getEnv().OUTBOX_BATCH_SIZE, deliveryLeaseSeconds(), randomUUID()],
    );
    if (claimed.length === 0) return [];

    // Шаг 2: данные для доставки. Отдельным запросом, а не подзапросами в
    // RETURNING: строки уже наши по аренде, и читать их можно спокойно.
    const { rows } = await tx.query<DeliveryRow>(
      `SELECT d.id, d.lease_id, d.endpoint_id, d.event_id, d.attempts,
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
   * Условие `lease_id = $2` — это ограждение. Идентификатор захвата новый на каждый
   * захват (M160): перехват строки обнуляет наше право на неё, даже если тот же
   * экземпляр позже возьмёт её снова.
   */
  private async renewLease(traceId: string, item: DeliveryRow): Promise<boolean> {
    return this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET lease_until = now() + make_interval(secs => $3)
          WHERE id = $1 AND lease_id = $2::uuid AND lease_until > now()`,
        [item.id, item.lease_id, deliveryLeaseSeconds()],
      );
      return (rowCount ?? 0) === 1;
    });
  }

  private async deliverOne(traceId: string, item: DeliveryRow): Promise<boolean> {
    // Граница контура проверяется ДО подготовки запроса и до расшифровки
    // секрета подписи: «не отправляем» должно означать, что наружу не ушло
    // ничего и что секрет ради этого даже не доставали.
    if (getEnv().WEBHOOK_DELIVERY_MODE === 'capture') {
      await this.markWithheld(
        traceId,
        item,
        'контур не выпускает наружу (WEBHOOK_DELIVERY_MODE=capture)',
      );
      return false;
    }
    const envelope = buildEnvelope(toOutboxRow(item));
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      // Резолв проверяется ПЕРЕД каждой доставкой: имя, безопасное при
      // регистрации, могло начать указывать во внутреннюю сеть. Проверенные
      // адреса используются дальше как есть — повторного разрешения имени
      // не происходит (DNS rebinding, SEC-05).
      const allowedAddresses = await assertPublicDestination(item.url);

      const secret = (
        await this.crypto.openDirect('webhook_secrets', item.secret_ciphertext, WEBHOOK_SECRET_AAD)
      ).toString('utf8');

      const response = await postPinned(item.url, {
        allowedAddresses,
        headers: {
          'Content-Type': 'application/json',
          'Fifth-Signature': signDelivery(secret, timestamp, body),
          'Fifth-Event-Id': item.event_id,
          'Fifth-Event-Type': item.event_type,
          'X-Request-Id': traceId,
        },
        body,
        // Внешний вызов без таймаута удерживает соединение бесконечно.
        timeoutMs: deliveryTimeoutMs(),
      });

      // Перенаправления не выполняются: 3xx считается неуспехом доставки, а не
      // приглашением сходить по адресу из Location.
      if (response.status >= 200 && response.status < 300) {
        await this.markDelivered(traceId, item, response.status);
        return true;
      }
      await this.markFailed(traceId, item, `HTTP ${response.status}`, response.status);
      return false;
    } catch (error) {
      if (isKmsUnavailable(error)) {
        await this.postponeForKeys(traceId, item);
        return false;
      }
      await this.markFailed(
        traceId,
        item,
        error instanceof Error ? error.message : String(error),
        null,
      );
      return false;
    }
  }

  /**
   * Служба ключей недоступна: получатель тут ни при чём, и попытка не расходуется. Иначе короткий
   * отказ OpenBao исчерпал бы доставки, которые дошли бы через минуту.
   */
  private async postponeForKeys(traceId: string, item: DeliveryRow): Promise<void> {
    await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'failed', next_retry_at = now() + make_interval(secs => $2),
                lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $3::uuid AND lease_until > now()`,
        [item.id, KEYS_RETRY_SECONDS, item.lease_id],
      );
    });
    this.logger.warn({ msg: 'доставка отложена: служба ключей недоступна', deliveryId: item.id });
  }

  /**
   * Перехвачено: наружу не ушло, и повторять не нужно.
   *
   * Состояние конечное и отдельное от `failed`. Смешать их нельзя: `failed`
   * стоит в очереди на повтор, и перехваченная доставка ходила бы по кругу,
   * а в отчёте о проблемах интеграции появился бы шум из событий, которые
   * никто и не собирался отправлять.
   *
   * Попытка не засчитывается: её не было.
   */
  private async markWithheld(traceId: string, item: DeliveryRow, reason: string): Promise<void> {
    await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'withheld', withheld_reason = $2, next_retry_at = NULL,
                lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $3::uuid AND lease_until > now()`,
        [item.id, reason, item.lease_id],
      );
      if ((rowCount ?? 0) === 0) {
        this.logger.warn({ msg: 'перехват не записан: аренда уже не наша', deliveryId: item.id });
      }
    });
    this.logger.log({
      msg: 'доставка наружу перехвачена контуром',
      deliveryId: item.id,
      eventType: item.event_type,
    });
  }

  private async markDelivered(traceId: string, item: DeliveryRow, code: number): Promise<void> {
    const id = item.id;
    await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      // Результат пишется, только пока строка НАША. Без этого условия
      // экземпляр, у которого аренду уже перехватили, затирал бы итог того,
      // кто отправляет её сейчас (SEC-06).
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'delivered', attempts = attempts + 1, response_code = $2,
                next_retry_at = NULL, lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $3::uuid AND lease_until > now()`,
        [id, code, item.lease_id],
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
                                     ELSE now() + make_interval(secs => $5) END,
                lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $6::uuid AND lease_until > now()`,
        [item.id, attempts, exhausted ? 'exhausted' : 'failed', code, delaySeconds, item.lease_id],
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
const KEYS_RETRY_SECONDS = 60;
const MAX_BACKOFF_SECONDS = 3600;

interface DeliveryRow {
  id: string;
  /** Захват этой строки (M160). */
  lease_id: string;
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
