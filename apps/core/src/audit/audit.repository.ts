import { Injectable } from '@nestjs/common';
import { uuidv7 } from '@unicorn/contracts';
import type { Tx } from '../db/unit-of-work';

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
    const { rows } = await tx.query<{ id: string }>(
      `SELECT audit.app_emit_event($1, $2, $3, $4, $5, $6::jsonb, $7) AS id`,
      [
        input.verb,
        input.actorId,
        input.actorRole,
        input.subjectType,
        input.subjectId,
        JSON.stringify(input.context ?? {}),
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
    await tx.query(
      `INSERT INTO audit.outbox_events
         (id, aggregate_type, aggregate_id, event_type, payload_jsonb, nats_subject,
          aggregate_version, message_key)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (aggregate_type, aggregate_id, aggregate_version, event_type) DO NOTHING`,
      [
        id,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        JSON.stringify(input.payload),
        input.natsSubject ?? input.eventType,
        input.aggregateVersion,
        input.messageKey ?? input.aggregateId,
      ],
    );
    return id;
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
