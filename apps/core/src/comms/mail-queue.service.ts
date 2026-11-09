import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uuidv7 } from '@fifth/contracts';
import { AvailabilityService } from '../availability/availability.service';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { resultOf } from '../background/job';
import { claimLeases, completeUnderLease, renewLease, type Lease } from '../background/lease';
import { getEnv } from '../config/env';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { sendTracked, startedWindowSeconds } from './mail-dispatch';
import { MailTransport, newMessageId, type MailOutcome } from './mail.transport';

const QUEUE = 'comms.mail_queue';
const SYSTEM = (traceId: string): RequestContext => ({ userId: null, roles: ['system'], traceId });
/** Повтор после неизвестного исхода — не больше одного (Тэнк 08.11). */
export const MAX_UNKNOWN = 1;
const MAX_PAUSE_MS = 5 * 60_000;

export type QueueSource =
  'support.ticket.opened' | 'support.message.added' | 'identity.user.registered';

/** Что делать со строкой после исхода отправки — чистое правило, проверяется модульно. */
export type QueueDecision =
  | { state: 'accepted' }
  | { state: 'pending'; countAttempt: boolean; countUnknown: boolean; pauseSender: boolean }
  | { state: 'failed' }
  | { state: 'unknown' };

export function decide(
  row: { attempts: number; unknownCount: number },
  outcome: MailOutcome,
  maxAttempts: number,
): QueueDecision {
  if (outcome.outcome === 'accepted') return { state: 'accepted' };
  if (outcome.outcome === 'unknown') {
    // Релей мог принять письмо. Один повтор с прежним Message-ID допустим (лишняя копия
    // возможна), второй неизвестный исход — окончательно «неизвестно».
    return row.unknownCount + 1 > MAX_UNKNOWN
      ? { state: 'unknown' }
      : { state: 'pending', countAttempt: false, countUnknown: true, pauseSender: false };
  }
  if (outcome.scope === 'transport') {
    // Канал или его настройка: письмо не виновато — попытка не расходуется, отправщик ждёт.
    return { state: 'pending', countAttempt: false, countUnknown: false, pauseSender: true };
  }
  return row.attempts + 1 >= maxAttempts
    ? { state: 'failed' }
    : { state: 'pending', countAttempt: true, countUnknown: false, pauseSender: false };
}

/**
 * Очередь служебных писем (4.11, M162): копия обращения и уведомление о регистрации.
 *
 *   * постановка — в транзакции исходного события; уникальность по событию: повтор запроса
 *     второй задачи не создаёт;
 *   * отправщик — общая аренда блока 1; перед диалогом с релеем строка отмечается `sending`
 *     отдельной фиксацией. Строка, найденная в `sending` при новом захвате (процесс упал во
 *     время отправки), — неизвестный исход: счётчик в БД, после перезапуска заново не
 *     начинается;
 *   * отказ канала (соединение, вход, настройка, группа «Почта» закрыта) попыток писем не
 *     расходует — отправщик встаёт на паузу, как публикатор событий;
 *   * «принято релеем» — ответ 250 после DATA, а не доставка адресату.
 */
@Injectable()
export class MailQueueService implements OnModuleInit {
  private readonly logger = new Logger(MailQueueService.name);
  private pausedUntil = 0;
  private pauseMs = 0;

  constructor(
    private readonly db: Database,
    private readonly mail: MailTransport,
    private readonly jobs: BackgroundJobsService,
    @Optional() private readonly availability?: AvailabilityService,
  ) {}

  onModuleInit(): void {
    this.jobs.register({
      name: 'mail.queue.send',
      intervalMs: getEnv().MAIL_QUEUE_POLL_MS,
      coordination: 'local',
      externalEffects: true,
      run: async ({ signal }) => resultOf(await this.runOnce(signal)),
    });
  }

  /**
   * Поставить служебное письмо в транзакции события.
   *
   * Намеренно выключено — получатель не задан (нет SUPPORT_INBOX_EMAIL; уведомление о
   * регистрации выключается своим флагом у вызывающего): письма нет. Получатель задан, а
   * транспорт выключен или не настроен — это недоступность канала, а не решение: письмо
   * сохраняется и ждёт, пока отправщик сможет его отправить.
   */
  async enqueue(
    tx: Tx,
    input: { source: QueueSource; sourceId: string; subject: string; text: string },
  ): Promise<void> {
    const inbox = getEnv().SUPPORT_INBOX_EMAIL;
    if (!inbox) {
      this.logger.warn({
        msg: 'служебное письмо не поставлено — получатель не задан',
        source: input.source,
      });
      return;
    }
    // Только функцией (M166): у роли пользовательских запросов нет ни чтения очереди, ни
    // прямой записи. Вызов — в транзакции события: её откат убирает и письмо; повтор того
    // же события прежнее письмо не перезаписывает.
    await tx.query(`SELECT comms.enqueue_service_mail($1, $2, $3, $4, $5, $6, $7)`, [
      uuidv7(),
      input.source,
      input.sourceId,
      inbox,
      input.subject,
      input.text,
      newMessageId(),
    ]);
  }

  /** Один проход: сколько писем принято релеем. */
  async runOnce(signal?: AbortSignal): Promise<number> {
    if (Date.now() < this.pausedUntil) return 0;
    // Транспорт выключен или не настроен: письма ждут в очереди, попытки не расходуются.
    if (!this.mail.available) return 0;
    // Группа «Почта» закрыта (размыкатель, отказ проверки, ручной запрет): письма ждут.
    if (this.availability && !(await this.availability.allows('write', 'mail'))) return 0;
    const traceId = `mail-queue-${randomUUID()}`;
    const leaseSeconds = startedWindowSeconds();
    const leases = await this.db.transaction(SYSTEM(traceId), (tx) =>
      claimLeases(tx, {
        table: QUEUE,
        where: `state IN ('pending', 'sending') AND next_attempt_at <= now()`,
        orderBy: 'next_attempt_at, created_at',
        limit: 10,
        seconds: leaseSeconds,
      }),
    );
    let accepted = 0;
    for (let i = 0; i < leases.length; i += 1) {
      const lease = leases[i]!;
      const rest = leases.slice(i);
      if (signal?.aborted || Date.now() < this.pausedUntil) {
        await this.release(traceId, rest);
        break;
      }
      const row = await this.begin(traceId, lease, leaseSeconds);
      if (row === 'lost') {
        await this.release(traceId, rest.slice(1));
        break;
      }
      if (row === 'closed') continue;
      const outcome = await sendTracked(this.mail, {
        to: row.recipient,
        subject: row.subject,
        text: row.body,
        messageId: row.message_id,
      });
      const decision = decide(
        { attempts: row.attempts, unknownCount: row.unknown_count },
        outcome,
        getEnv().MAIL_QUEUE_MAX_ATTEMPTS,
      );
      if (!(await this.finish(traceId, lease, decision, outcome))) {
        this.logger.warn({ msg: 'аренда письма потеряна после отправки', id: lease.id });
        await this.release(traceId, rest.slice(1));
        break;
      }
      if (decision.state === 'accepted') {
        accepted += 1;
        this.resume();
      }
      if (decision.state === 'pending' && decision.pauseSender) {
        this.pause(outcome);
        await this.release(traceId, rest.slice(1));
        break;
      }
    }
    return accepted;
  }

  /**
   * Устойчивая отметка «отправка начата» — отдельной фиксацией до диалога с релеем. Строка
   * уже в `sending` — прежняя отправка оборвалась: это неизвестный исход, он считается здесь.
   */
  private async begin(
    traceId: string,
    lease: Lease,
    leaseSeconds: number,
  ): Promise<
    | 'lost'
    | 'closed'
    | {
        recipient: string;
        subject: string;
        body: string;
        message_id: string;
        attempts: number;
        unknown_count: number;
      }
  > {
    return this.db.transaction(SYSTEM(traceId), async (tx) => {
      if (!(await renewLease(tx, { table: QUEUE, lease, seconds: leaseSeconds }))) return 'lost';
      const { rows } = await tx.query<{
        state: string;
        recipient: string;
        subject: string;
        body: string;
        message_id: string;
        attempts: number;
        unknown_count: number;
      }>(
        `UPDATE comms.mail_queue
            SET unknown_count = unknown_count + CASE WHEN state = 'sending' THEN 1 ELSE 0 END,
                state = CASE WHEN state = 'sending' AND unknown_count >= $3 THEN 'unknown'
                             ELSE 'sending' END
          WHERE id = $1 AND lease_id = $2::uuid AND lease_until > now()
      RETURNING state, recipient, subject, body, message_id, attempts, unknown_count`,
        [lease.id, lease.leaseId, MAX_UNKNOWN],
      );
      const row = rows[0];
      if (!row) return 'lost';
      if (row.state === 'unknown') {
        await completeUnderLease(tx, { table: QUEUE, lease, set: `state = 'unknown'` });
        this.logger.warn({
          msg: 'служебное письмо: исход неизвестен, повторов больше нет',
          id: lease.id,
        });
        return 'closed';
      }
      return row;
    });
  }

  private async finish(
    traceId: string,
    lease: Lease,
    decision: QueueDecision,
    outcome: MailOutcome,
  ): Promise<boolean> {
    const stage = outcome.outcome === 'accepted' ? null : outcome.stage;
    const code = outcome.outcome === 'not_sent' ? outcome.code : null;
    let set: string;
    if (decision.state === 'accepted') {
      // Копия у адресата: текст в очереди больше не хранится.
      set = `state = 'accepted', accepted_at = now(), body = '', last_stage = NULL, last_code = NULL`;
    } else if (decision.state === 'failed') {
      set = `state = 'failed', attempts = attempts + 1, last_stage = $1, last_code = $2`;
    } else if (decision.state === 'unknown') {
      set = `state = 'unknown', unknown_count = unknown_count + 1, last_stage = $1, last_code = $2`;
    } else {
      set =
        `state = 'pending', last_stage = $1, last_code = $2` +
        (decision.countAttempt ? ', attempts = attempts + 1' : '') +
        (decision.countUnknown ? ', unknown_count = unknown_count + 1' : '') +
        (decision.pauseSender
          ? ''
          : `, next_attempt_at = now() + make_interval(secs => least(300, 15 * power(2, attempts + unknown_count)))`);
    }
    const params = decision.state === 'accepted' ? [] : [stage, code];
    return this.db.transaction(SYSTEM(traceId), (tx) =>
      completeUnderLease(tx, { table: QUEUE, lease, set, params }),
    );
  }

  /** Освободить ещё не начатые строки: их состояние не менялось, попытки не тратятся. */
  private async release(traceId: string, leases: Lease[]): Promise<void> {
    if (leases.length === 0) return;
    await this.db
      .transaction(SYSTEM(traceId), async (tx) => {
        for (const lease of leases) {
          await tx.query(
            `UPDATE comms.mail_queue SET lease_id = NULL, lease_until = NULL
              WHERE id = $1 AND lease_id = $2::uuid AND state <> 'sending'`,
            [lease.id, lease.leaseId],
          );
        }
      })
      .catch(() => undefined);
  }

  private pause(outcome: MailOutcome): void {
    this.pauseMs = Math.min(Math.max(this.pauseMs * 2, 5_000), MAX_PAUSE_MS);
    this.pausedUntil = Date.now() + this.pauseMs;
    this.logger.warn({
      msg: 'почтовый канал недоступен: служебные письма ждут, попытки не расходуются',
      stage: outcome.outcome === 'not_sent' ? outcome.stage : null,
      pauseSeconds: Math.round(this.pauseMs / 1000),
    });
  }

  private resume(): void {
    if (this.pauseMs > 0) this.logger.log({ msg: 'почтовый канал снова принимает письма' });
    this.pauseMs = 0;
    this.pausedUntil = 0;
  }
}
