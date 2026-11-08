import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AvailabilityService } from '../availability/availability.service';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { resultOf } from '../background/job';
import { getEnv } from '../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type Tx } from '../db/unit-of-work';
import { buildEnvelope, type OutboxRow } from './publisher.service';
import {
  classifyDeliveryFailure,
  destinationPause,
  egressMonitor,
  isTransientDns,
  type DeliveryFailureKind,
} from './events-health';
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
 *
 * Контур доставки группы «События» (4.11) — независим от брокера:
 *
 *   * пауза по получателю (узел «хост:порт», M163): после отказа доставки на узел его
 *     остальные доставки ждут без расхода попыток; по истечении паузы одна пробная доставка
 *     под арендой пробы проверяет адрес — успех снимает паузу, отказ удваивает её до предела.
 *     Проба — обычная доставка: её попытки и конечный исход сохраняются;
 *   * предполагаемый общий сбой (транспортные отказы у трёх разных узлов за минуту) —
 *     пауза всех доставок в экземпляре, по её истечении одна проба;
 *   * ручной запрет группы останавливает доставку целиком; проба его не снимает.
 */
/** Исходящий HTTP доставки: в проверках подменяется, SSRF-защита в нём не ослабляется. */
export interface DeliveryTransport {
  resolve: (url: string) => Promise<string[]>;
  post: typeof postPinned;
}
const defaultTransport: DeliveryTransport = { resolve: assertPublicDestination, post: postPinned };

@Injectable()
export class WebhookDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(WebhookDeliveryService.name);
  /** Кто держит аренду: по нему видно, какой экземпляр завис. */

  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly jobs: BackgroundJobsService,
    @Optional() private readonly availability?: AvailabilityService,
  ) {}

  /** Исходящий HTTP; модульные проверки подставляют свой. */
  transport: DeliveryTransport = defaultTransport;

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
    // Ручной запрет группы «События» — доставка стоит целиком, проба его не снимает.
    if (this.availability && (await this.availability.restrictionOf('events'))) return 0;
    // Предполагаемый общий сбой: пауза, затем одна проба. Состояние группы пробу не держит.
    const gate = egressMonitor().gate();
    if (gate === 'paused') return 0;
    const limit = gate === 'probe' ? 1 : getEnv().OUTBOX_BATCH_SIZE;

    const batch = await this.db.asServiceRole('app_integration', { traceId }, async (tx) =>
      this.lockBatch(tx, limit),
    );
    if (batch.length === 0) return 0;

    let delivered = 0;
    /** Узлы, отказавшие в этом проходе: их оставшиеся доставки ждут без попыток. */
    const pausedHere = new Set<string>();
    for (let i = 0; i < batch.length; i += 1) {
      const item = batch[i]!;
      if (signal?.aborted || egressMonitor().gate() === 'paused') {
        await this.release(traceId, batch.slice(i));
        break;
      }
      if (pausedHere.has(item.destination)) {
        await this.release(traceId, [item]);
        continue;
      }
      // Аренда продлевается ПЕРЕД каждой доставкой, а не берётся одна на всю
      // пачку. Прежняя схема была арифметически несостоятельна: до
      // OUTBOX_BATCH_SIZE строк (по умолчанию 50) получали общую аренду в
      // DELIVERY_LEASE_SECONDS, а отправлялись последовательно, каждая до
      // нескольких секунд. К концу пачки аренда давно истекала, другой
      // экземпляр забирал те же строки и слал вебхук ВТОРОЙ раз — а побочный
      // эффект у получателя настоящий: списание, сделка, запись в CRM
      // (SEC-06).
      if (!(await this.renewLease(traceId, item).catch(lostProbe))) {
        // Захват уже не наш: дальше не идём вовсе — пачка могла уйти другому исполнителю.
        this.logger.warn({
          msg: 'аренда доставки потеряна, проход остановлен',
          deliveryId: item.id,
          eventType: item.event_type,
        });
        await this.release(traceId, batch.slice(i + 1));
        break;
      }
      const outcome = await this.deliverOne(traceId, item);
      if (outcome === 'not_delivered' && this.lastFailure !== 'platform') {
        pausedHere.add(item.destination);
      }
      if (outcome === 'lease_lost') {
        // Итог не записан: захват ушёл, пока шёл запрос. Успехом это не считается, и дальше
        // проход не идёт — следующие строки могли уйти другому исполнителю.
        this.logger.warn({
          msg: 'аренда доставки потеряна во время обработки, проход остановлен',
          deliveryId: item.id,
          eventType: item.event_type,
        });
        await this.release(traceId, batch.slice(i + 1));
        break;
      }
      if (outcome === 'delivered') delivered += 1;
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
  private async lockBatch(tx: Tx, limit: number): Promise<DeliveryRow[]> {
    const leaseId = randomUUID();
    // Шаг 0: аренда проб (M163). Узел, у которого пауза истекла и пробу никто не держит,
    // переходит под пробу этого захвата. Условие и отметка — одно выражение: двое
    // исполнителей один узел одновременно не проверяют.
    await tx.query(
      `UPDATE integration.webhook_destinations w
          SET probe_lease_id = $1::uuid, probe_until = now() + make_interval(secs => $2)
        WHERE w.destination IN (
          SELECT destination FROM integration.webhook_destinations
           WHERE paused_until <= now() AND (probe_until IS NULL OR probe_until < now())
           FOR UPDATE SKIP LOCKED)`,
      [leaseId, deliveryLeaseSeconds()],
    );
    // Шаг 1: захват. Узлы без паузы — как раньше; узел под нашей пробой — ровно одна,
    // старейшая доставка; узел на паузе — ни одной: его доставки ждут без попыток.
    // Повторная проверка аренды во внешнем UPDATE не даёт двум захватам взять одну строку.
    const { rows: claimed } = await tx.query<{ id: string }>(
      `UPDATE integration.webhook_deliveries d
          SET lease_id = $4::uuid,
              lease_until = now() + make_interval(secs => $3)
        WHERE d.id IN (
          SELECT c.id FROM (
            SELECT d2.id, d2.created_at, w.destination IS NOT NULL AS probe,
                   row_number() OVER (PARTITION BY e2.destination ORDER BY d2.created_at) AS rn
              FROM integration.webhook_deliveries d2
              JOIN integration.webhook_endpoints e2 ON e2.id = d2.endpoint_id
              LEFT JOIN integration.webhook_destinations w ON w.destination = e2.destination
             WHERE d2.status IN ('queued', 'failed')
               AND (d2.next_retry_at IS NULL OR d2.next_retry_at <= now())
               AND d2.attempts < $1
               AND e2.status = 'active'
               AND (d2.lease_until IS NULL OR d2.lease_until < now())
               AND (d2.locked_until IS NULL OR d2.locked_until < now())
               AND (w.destination IS NULL
                    OR (w.probe_lease_id = $4::uuid AND w.probe_until > now()))
          ) c
           WHERE NOT c.probe OR c.rn = 1
           ORDER BY c.created_at
           LIMIT $2)
          AND (d.lease_until IS NULL OR d.lease_until < now())
          AND (d.locked_until IS NULL OR d.locked_until < now())
      RETURNING d.id`,
      [MAX_ATTEMPTS, limit, deliveryLeaseSeconds(), leaseId],
    );
    // Пробы, которым не нашлось доставки, отпускаются сразу.
    await tx.query(
      `UPDATE integration.webhook_destinations w
          SET probe_lease_id = NULL, probe_until = NULL
        WHERE w.probe_lease_id = $1::uuid
          AND w.destination NOT IN (
            SELECT e.destination FROM integration.webhook_deliveries d
              JOIN integration.webhook_endpoints e ON e.id = d.endpoint_id
             WHERE d.id = ANY($2::uuid[]))`,
      [leaseId, claimed.map((row) => row.id)],
    );
    if (claimed.length === 0) return [];

    // Шаг 2: данные для доставки. Отдельным запросом, а не подзапросами в
    // RETURNING: строки уже наши по аренде, и читать их можно спокойно.
    const { rows } = await tx.query<DeliveryRow>(
      `SELECT d.id, d.lease_id, d.endpoint_id, d.event_id, d.attempts,
              e.url, e.secret_ciphertext, e.status AS endpoint_status, e.destination,
              (w.probe_lease_id IS NOT NULL AND w.probe_lease_id = d.lease_id) AS is_probe,
              o.id AS outbox_id, o.aggregate_type, o.aggregate_id, o.aggregate_version,
              o.event_type, o.payload_jsonb, o.nats_subject, o.schema_version,
              o.message_key, o.created_at
         FROM integration.webhook_deliveries d
         JOIN integration.webhook_endpoints e ON e.id = d.endpoint_id
         JOIN audit.outbox_events o ON o.id = d.event_id
         LEFT JOIN integration.webhook_destinations w ON w.destination = e.destination
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
      if ((rowCount ?? 0) !== 1) return false;
      // Проба узла (M163): её аренда продлевается тем же шагом. Пробу перехватили или её срок
      // вышел — отправку не начинать, иначе второй исполнитель уже проверяет узел своей
      // доставкой и проб станет две. Откат транзакции снимает и продление доставки.
      if (item.is_probe) {
        const { rowCount: probe } = await tx.query(
          `UPDATE integration.webhook_destinations
              SET probe_until = now() + make_interval(secs => $3)
            WHERE destination = $1 AND probe_lease_id = $2::uuid AND probe_until > now()`,
          [item.destination, item.lease_id, deliveryLeaseSeconds()],
        );
        if ((probe ?? 0) !== 1) throw new ProbeLost();
      }
      return true;
    });
  }

  /** Итог одной доставки: `lease_lost` — завершающая запись не прошла, захват уже не наш. */
  /** Вид последнего отказа в этом экземпляре — проходу, чтобы не ставить узел на паузу зря. */
  private lastFailure: DeliveryFailureKind | null = null;

  private async deliverOne(traceId: string, item: DeliveryRow): Promise<DeliveryOutcome> {
    this.lastFailure = null;
    // Граница контура проверяется ДО подготовки запроса и до расшифровки
    // секрета подписи: «не отправляем» должно означать, что наружу не ушло
    // ничего и что секрет ради этого даже не доставали.
    if (getEnv().WEBHOOK_DELIVERY_MODE === 'capture') {
      const kept = await this.markWithheld(
        traceId,
        item,
        'контур не выпускает наружу (WEBHOOK_DELIVERY_MODE=capture)',
      );
      return kept ? 'not_delivered' : 'lease_lost';
    }
    const envelope = buildEnvelope(toOutboxRow(item));
    const body = JSON.stringify(envelope);
    const timestamp = Math.floor(Date.now() / 1000);

    try {
      // Резолв проверяется ПЕРЕД каждой доставкой: имя, безопасное при
      // регистрации, могло начать указывать во внутреннюю сеть. Проверенные
      // адреса используются дальше как есть — повторного разрешения имени
      // не происходит (DNS rebinding, SEC-05).
      const allowedAddresses = await this.transport.resolve(item.url);

      const secret = (
        await this.crypto.openDirect('webhook_secrets', item.secret_ciphertext, WEBHOOK_SECRET_AAD)
      ).toString('utf8');

      const response = await this.transport.post(item.url, {
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
      // Ответ получен — сеть до получателя работает, каким бы ни был код.
      egressMonitor().networkWorks();
      if (response.status >= 200 && response.status < 300) {
        if (!(await this.markDelivered(traceId, item, response.status))) return 'lease_lost';
        await this.destinationOk(traceId, item);
        return 'delivered';
      }
      this.lastFailure = 'receiver';
      if (!(await this.markFailed(traceId, item, `HTTP ${response.status}`, response.status))) {
        return 'lease_lost';
      }
      await this.destinationFailed(traceId, item, 'receiver');
      return 'not_delivered';
    } catch (error) {
      const kind = classifyDeliveryFailure(error);
      this.lastFailure = kind;
      if (kind === 'platform') {
        // Наша служба ключей: получатель ни при чём, проба узла отпускается.
        if (item.is_probe) await this.releaseProbe(traceId, item);
        return (await this.postponeForKeys(traceId, item)) ? 'not_delivered' : 'lease_lost';
      }
      if (isTransientDns(error)) {
        // Временный сбой нашего резолвера: получатель ни при чём — попытка не расходуется,
        // узел на паузу не ставится. В общий сигнал сбоя это входит.
        this.lastFailure = 'platform';
        egressMonitor().transportFailure(item.destination);
        if (item.is_probe) await this.releaseProbe(traceId, item);
        return (await this.postponeWithoutAttempt(traceId, item, DNS_RETRY_SECONDS, 'dns'))
          ? 'not_delivered'
          : 'lease_lost';
      }
      if (kind === 'transport') egressMonitor().transportFailure(item.destination);
      else egressMonitor().networkWorks();
      const reason =
        kind === 'unknown'
          ? 'исход неизвестен: тело передано, ответа нет (не подтверждённый отказ получателя)'
          : error instanceof Error
            ? error.message
            : String(error);
      if (!(await this.markFailed(traceId, item, reason, null))) return 'lease_lost';
      await this.destinationFailed(traceId, item, kind);
      return 'not_delivered';
    }
  }

  /**
   * Служба ключей недоступна: получатель тут ни при чём, и попытка не расходуется. Иначе короткий
   * отказ OpenBao исчерпал бы доставки, которые дошли бы через минуту.
   */
  private async postponeForKeys(traceId: string, item: DeliveryRow): Promise<boolean> {
    return this.postponeWithoutAttempt(traceId, item, KEYS_RETRY_SECONDS, 'keys');
  }

  /** Отложить без расхода попытки: служба ключей или временный сбой резолвера — наши. */
  private async postponeWithoutAttempt(
    traceId: string,
    item: DeliveryRow,
    seconds: number,
    why: 'keys' | 'dns',
  ): Promise<boolean> {
    const kept = await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'failed', next_retry_at = now() + make_interval(secs => $2),
                lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $3::uuid AND lease_until > now()`,
        [item.id, seconds, item.lease_id],
      );
      return (rowCount ?? 0) === 1;
    });
    if (kept) {
      this.logger.warn({
        msg:
          why === 'keys'
            ? 'доставка отложена: служба ключей недоступна'
            : 'доставка отложена: временный сбой DNS, попытка не расходуется',
        deliveryId: item.id,
      });
    }
    return kept;
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
  private async markWithheld(traceId: string, item: DeliveryRow, reason: string): Promise<boolean> {
    const kept = await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = 'withheld', withheld_reason = $2, next_retry_at = NULL,
                lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $3::uuid AND lease_until > now()`,
        [item.id, reason, item.lease_id],
      );
      return (rowCount ?? 0) === 1;
    });
    if (!kept) {
      this.logger.warn({ msg: 'перехват не записан: аренда уже не наша', deliveryId: item.id });
      return false;
    }
    this.logger.log({
      msg: 'доставка наружу перехвачена контуром',
      deliveryId: item.id,
      eventType: item.event_type,
    });
    return true;
  }

  /** Узел ответил успехом: пауза снята (строки узла нет). */
  private async destinationOk(traceId: string, item: DeliveryRow): Promise<void> {
    await this.db
      .asServiceRole('app_integration', { traceId }, (tx) =>
        tx.query('DELETE FROM integration.webhook_destinations WHERE destination = $1', [
          item.destination,
        ]),
      )
      .catch((error: unknown) =>
        this.logger.warn({ msg: 'пауза узла не снята', destination: item.destination, error }),
      );
  }

  /**
   * Отказ на узле: пауза. Отказ пробы удваивает паузу до предела и отпускает пробу; отказ
   * обычной доставки (соседняя уже в полёте) паузу только продлевает до прежней длины.
   */
  private async destinationFailed(
    traceId: string,
    item: DeliveryRow,
    kind: Exclude<DeliveryFailureKind, 'platform'>,
  ): Promise<void> {
    const { baseSeconds, maxSeconds } = destinationPause();
    await this.db
      .asServiceRole('app_integration', { traceId }, (tx) =>
        tx.query(
          `INSERT INTO integration.webhook_destinations AS w
             (destination, failures, pause_seconds, paused_until, last_failure_kind)
           VALUES ($1, 1, $2::int, now() + make_interval(secs => $2::int), $3)
           ON CONFLICT (destination) DO UPDATE SET
             failures = w.failures + 1,
             last_failure_kind = EXCLUDED.last_failure_kind,
             last_failure_at = now(),
             pause_seconds = CASE WHEN w.probe_lease_id = $4::uuid
                                  THEN least(w.pause_seconds * 2, $5::int) ELSE w.pause_seconds END,
             paused_until = CASE WHEN w.probe_lease_id = $4::uuid
                                 THEN now() + make_interval(secs => least(w.pause_seconds * 2, $5::int))
                                 ELSE greatest(w.paused_until,
                                               now() + make_interval(secs => w.pause_seconds)) END,
             probe_lease_id = CASE WHEN w.probe_lease_id = $4::uuid THEN NULL
                                   ELSE w.probe_lease_id END,
             probe_until = CASE WHEN w.probe_lease_id = $4::uuid THEN NULL ELSE w.probe_until END`,
          [item.destination, baseSeconds, kind, item.lease_id, maxSeconds],
        ),
      )
      .catch((error: unknown) =>
        this.logger.warn({ msg: 'пауза узла не записана', destination: item.destination, error }),
      );
  }

  /** Проба не состоялась по нашей причине: узел снова свободен для следующей пробы. */
  private async releaseProbe(traceId: string, item: DeliveryRow): Promise<void> {
    await this.db
      .asServiceRole('app_integration', { traceId }, (tx) =>
        tx.query(
          `UPDATE integration.webhook_destinations SET probe_lease_id = NULL, probe_until = NULL
            WHERE destination = $1 AND probe_lease_id = $2::uuid`,
          [item.destination, item.lease_id],
        ),
      )
      .catch(() => undefined);
  }

  private async markDelivered(traceId: string, item: DeliveryRow, code: number): Promise<boolean> {
    const id = item.id;
    return this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
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
        return false;
      }
      return true;
    });
  }

  private async markFailed(
    traceId: string,
    item: DeliveryRow,
    reason: string,
    code: number | null,
  ): Promise<boolean> {
    const attempts = item.attempts + 1;
    const exhausted = attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(2 ** attempts, MAX_BACKOFF_SECONDS);

    const kept = await this.db.asServiceRole('app_integration', { traceId }, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE integration.webhook_deliveries
            SET status = $3, attempts = $2, response_code = $4,
                next_retry_at = CASE WHEN $3 = 'exhausted' THEN NULL
                                     ELSE now() + make_interval(secs => $5) END,
                lease_id = NULL, lease_until = NULL
          WHERE id = $1 AND lease_id = $6::uuid AND lease_until > now()`,
        [item.id, attempts, exhausted ? 'exhausted' : 'failed', code, delaySeconds, item.lease_id],
      );
      return (rowCount ?? 0) === 1;
    });
    if (!kept) {
      this.logger.warn({
        msg: 'отказ доставки не записан: аренда уже не наша',
        deliveryId: item.id,
      });
      return false;
    }

    this.logger[exhausted ? 'error' : 'warn']({
      msg: exhausted ? 'доставка вебхука прекращена' : 'доставка вебхука отложена',
      deliveryId: item.id,
      eventType: item.event_type,
      attempts,
      // Причина — без тела ответа получателя: оно чужое и может содержать что угодно.
      reason: reason.slice(0, 200),
    });
    return true;
  }
}

type DeliveryOutcome = 'delivered' | 'not_delivered' | 'lease_lost';

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
/** Повтор после временного сбоя резолвера; настраивается для проверок. */
const DNS_RETRY_SECONDS = Number(process.env.WEBHOOK_DNS_RETRY_S ?? 30);

/** Аренда пробы узла уже не наша: отправку не начинать. */
class ProbeLost extends Error {}
const lostProbe = (error: unknown): false => {
  if (error instanceof ProbeLost) return false;
  throw error;
};
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
  /** Узел назначения «хост:порт» (M163). */
  destination: string;
  /** Эта доставка — проба узла на паузе. */
  is_probe: boolean;
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
