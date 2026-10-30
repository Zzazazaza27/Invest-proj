import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { claimLeases, completeUnderLease, renewLease, type Lease } from '../background/lease';
import type { Database, Tx } from '../db/unit-of-work';
import type { S3Service } from './s3.service';

/**
 * Общая функция завершения загрузки (2.1.2, 3.3; работа 2.1-W03).
 *
 * Её вызывают и браузерное подтверждение, и фоновая сверка — одна и та же
 * последовательность с одной защитой:
 *
 *  1. захват аренды строки загрузки (новый id на каждый захват, W01);
 *  2. HEAD временного объекта формы;
 *  3. запись попытки с НОВЫМ окончательным ключом — до CopyObject, чтобы
 *     после сбоя найти и копии, не ставшие итоговым файлом;
 *  4. CopyObject → потоковое чтение копии: размер, SHA-256, сигнатура;
 *  5. публикация ОДНОЙ транзакцией: условный UPDATE строки под действующей
 *     арендой (`lease_id` совпадает И `lease_until > now()`), отметка попытки,
 *     событие журнала. Не изменил строку — откат, попытка не опубликована.
 *
 * Чего функция не делает: не удаляет ни записей, ни объектов, и не объявляет
 * файл отсутствующим по таймауту или ошибке хранилища — это «результат
 * неизвестен», с диагностикой и повтором по нарастающей паузе.
 *
 * Все обращения к БД — под ролью обслуживания: права пользователя браузерный
 * путь проверяет раньше, своим контекстом.
 */

export type UploadState = 'pending' | 'ready' | 'rejected' | 'needs_attention' | 'cancelled';

export interface UploadRow {
  id: string;
  project_id: string;
  type: string;
  uploaded_by: string;
  upload_state: UploadState;
  upload_state_reason: string | null;
  upload_key: string | null;
  upload_expires_at: Date | null;
  upload_max_bytes: string | null;
  object_received_at: Date | null;
  not_received_at: Date | null;
  s3_key: string | null;
  size_bytes: string | null;
  content_hash: string | null;
  check_failures: number;
  unknown_since: Date | null;
}

export interface UploadTarget {
  /** Таблица записей загрузки (с колонками M147) и таблица попыток. */
  table: string;
  attemptsTable: string;
  /** Окончательный ключ попытки; формирует хранилище, не вызывающий. */
  finalKey(row: UploadRow, attemptId: string): string;
  /** Проверка содержимого: `null` — подходит, строка — причина отклонения. */
  validate(row: UploadRow, digest: { sizeBytes: number; head: Buffer }): string | null;
  /** Тип содержимого готового файла по проверенной сигнатуре. */
  contentType(row: UploadRow, head: Buffer): string | null;
  /** Событие журнала публикации — в той же транзакции. */
  emitPublished(tx: Tx, row: UploadRow, info: PublishInfo): Promise<void>;
}

export interface PublishInfo {
  sizeBytes: number;
  sha256: string;
  finalKey: string;
  executor: 'browser' | 'reconcile';
  actorId: string | null;
  traceId: string;
}

export interface CompletionOutcome {
  state: UploadState;
  /** Хранилище подтвердило получение объекта формы. */
  received: boolean;
  /** Обработку сейчас ведёт другой исполнитель. */
  busy: boolean;
  reason: string | null;
}

/** Начальные настройки длительной обработки (согласованы в плане W03). */
export const UPLOAD_COMPLETION = {
  leaseSeconds: 120,
  renewEveryMs: 30_000,
  headTimeoutMs: 10_000,
  copyTimeoutMs: 60_000,
  readIdleMs: 30_000,
  readTotalMs: 15 * 60_000,
  /** Технических неудач подряд до «требует вмешательства». */
  maxFailures: 10,
  /** Непрерывный неизвестный результат до «требует вмешательства». */
  maxUnknownMs: 24 * 3_600_000,
  /** Проверки свежей загрузки и после срока формы. */
  freshCheckMs: 60_000,
  expiredCheckMs: 3_600_000,
} as const;

const SELECT_ROW = `id, project_id, type, uploaded_by, upload_state, upload_state_reason,
  upload_key, upload_expires_at, upload_max_bytes::text AS upload_max_bytes,
  object_received_at, not_received_at, s3_key, size_bytes::text AS size_bytes,
  content_hash, check_failures, unknown_since`;

/** Пауза перед следующей проверкой после n-й неудачи подряд: 1, 2, 4 … 60 мин. */
export function failureBackoffMs(failures: number): number {
  return Math.min(2 ** Math.max(0, failures - 1), 60) * 60_000;
}

class LeaseLost extends Error {
  constructor() {
    super('аренда загрузки потеряна');
  }
}

export class UploadCompletion {
  private readonly logger = new Logger(UploadCompletion.name);

  constructor(
    private readonly db: Database,
    private readonly s3: S3Service,
    private readonly target: UploadTarget,
  ) {}

  private tx<T>(traceId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.asServiceRole('app_maintenance', { traceId }, work);
  }

  /**
   * Транзакция, меняющая состояние загрузки. Сигнал проверяется ВНУТРИ — после
   * получения соединения и перед изменением: остановка, пришедшая во время
   * ожидания БД, не должна превратиться в публикацию или запись неудачи.
   */
  private change<T>(
    traceId: string,
    signal: AbortSignal,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.tx(traceId, async (tx) => {
      signal.throwIfAborted();
      return work(tx);
    });
  }

  async readRow(id: string, traceId: string): Promise<UploadRow | null> {
    return this.tx(traceId, async (tx) => {
      const { rows } = await tx.query<UploadRow>(
        `SELECT ${SELECT_ROW} FROM ${this.target.table} WHERE id = $1`,
        [id],
      );
      return rows[0] ?? null;
    });
  }

  /**
   * Завершить загрузку, если это возможно сейчас. Никогда не объявляет успех
   * без опубликованной проверенной копии.
   */
  async complete(
    id: string,
    options: {
      executor: 'browser' | 'reconcile';
      actorId: string | null;
      traceId: string;
      signal?: AbortSignal;
    },
  ): Promise<CompletionOutcome> {
    const { traceId } = options;
    const external = options.signal ?? new AbortController().signal;
    let lease: Lease | undefined;
    try {
      [lease] = await this.change(traceId, external, (tx) =>
        claimLeases(tx, {
          table: this.target.table,
          where: `id = $1 AND upload_state = 'pending' AND type <> 'product_link'`,
          params: [id],
          limit: 1,
          seconds: UPLOAD_COMPLETION.leaseSeconds,
        }),
      );
    } catch (error) {
      if (!external.aborted) throw error;
    }
    if (!lease) {
      const row = await this.readRow(id, traceId);
      if (!row) throw new Error(`запись загрузки ${id} не найдена`);
      return {
        state: row.upload_state,
        received: row.object_received_at !== null,
        busy: row.upload_state === 'pending',
        reason: row.upload_state_reason,
      };
    }
    const held = lease;

    // Продление аренды по ходу долгой работы. Не продлилась — прерывание:
    // следующее действие не начинается, публикацию отсечёт условие UPDATE.
    const lost = new AbortController();
    const heartbeat = setInterval(() => {
      void this.tx(traceId, (tx) =>
        renewLease(tx, {
          table: this.target.table,
          lease: held,
          seconds: UPLOAD_COMPLETION.leaseSeconds,
        }),
      ).then(
        (ok) => {
          if (!ok) lost.abort(new LeaseLost());
        },
        () => lost.abort(new LeaseLost()),
      );
    }, UPLOAD_COMPLETION.renewEveryMs);
    heartbeat.unref();
    const signal = AbortSignal.any([external, lost.signal]);

    try {
      const row = await this.readRow(id, traceId);
      if (!row) throw new Error(`запись загрузки ${id} не найдена`);
      return await this.process(row, held, signal, options);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async process(
    row: UploadRow,
    lease: Lease,
    signal: AbortSignal,
    options: { executor: 'browser' | 'reconcile'; actorId: string | null; traceId: string },
  ): Promise<CompletionOutcome> {
    const { traceId } = options;
    // Прерывание — не неудача: ни записи о сбое, ни отсчёта неизвестности.
    // Аренда истечёт сама, и работу продолжит следующий исполнитель.
    const stop = (error: unknown): CompletionOutcome | null =>
      signal.aborted || error instanceof LeaseLost ? this.interrupted(row) : null;

    if (!row.upload_key) {
      return this.settle(
        row,
        lease,
        signal,
        traceId,
        'needs_attention',
        'нет временного ключа загрузки',
      );
    }

    // 1. Получен ли объект формы.
    let head: { exists: boolean; sizeBytes: number | null };
    try {
      signal.throwIfAborted();
      head = await this.s3.headObject(row.upload_key);
    } catch (error) {
      return stop(error) ?? this.unknown(row, lease, signal, traceId, error);
    }
    if (!head.exists) {
      // Хранилище раньше подтвердило объект, а теперь его нет — утрачен
      // полученный источник (2.1.2): это не «ещё не загружено».
      if (row.object_received_at) {
        return this.settle(
          row,
          lease,
          signal,
          traceId,
          'needs_attention',
          'утрачен ранее полученный объект',
        );
      }
      return this.notYetReceived(row, lease, signal, traceId);
    }

    const maxBytes = row.upload_max_bytes === null ? null : Number(row.upload_max_bytes);
    if (maxBytes !== null && head.sizeBytes !== null && head.sizeBytes > maxBytes) {
      return this.settle(
        row,
        lease,
        signal,
        traceId,
        'rejected',
        `размер больше предела ${maxBytes} байт`,
      );
    }

    // 2. Отметка получения и попытка с новым окончательным ключом — в БД до
    // копирования.
    const attemptId = randomUUID();
    const finalKey = this.target.finalKey(row, attemptId);
    try {
      await this.change(traceId, signal, async (tx) => {
        const { rowCount } = await tx.query(
          `UPDATE ${this.target.table}
              SET object_received_at = coalesce(object_received_at, now()), not_received_at = NULL
            WHERE id = $1 AND lease_id = $2::uuid AND lease_until > now()`,
          [row.id, lease.leaseId],
        );
        if (rowCount !== 1) throw new LeaseLost();
        await tx.query(
          `INSERT INTO ${this.target.attemptsTable} (id, material_id, final_key, lease_id)
           VALUES ($1, $2, $3, $4::uuid)`,
          [attemptId, row.id, finalKey, lease.leaseId],
        );
      });
    } catch (error) {
      return stop(error) ?? this.unknown(row, lease, signal, traceId, error);
    }
    row.object_received_at ??= new Date();

    // 3. Копия и её проверка по содержимому.
    let digest: { exists: boolean; sizeBytes: number; sha256: string | null; head: Buffer };
    try {
      signal.throwIfAborted();
      await this.s3.copyObject({
        sourceKey: row.upload_key,
        destinationKey: finalKey,
        timeoutMs: UPLOAD_COMPLETION.copyTimeoutMs,
        signal,
      });
      await this.markAttempt(attemptId, 'copied', null, traceId);
      signal.throwIfAborted();
      digest = await this.s3.readObjectDigest(finalKey, {
        idleMs: UPLOAD_COMPLETION.readIdleMs,
        totalMs: UPLOAD_COMPLETION.readTotalMs,
        signal,
      });
    } catch (error) {
      const interrupted = stop(error);
      await this.markAttempt(
        attemptId,
        interrupted ? 'abandoned' : 'failed',
        interrupted ? 'прервано' : errorText(error),
        traceId,
      ).catch(() => undefined);
      return interrupted ?? this.unknown(row, lease, signal, traceId, error);
    }
    if (!digest.exists || digest.sha256 === null) {
      await this.markAttempt(attemptId, 'failed', 'копия не найдена после копирования', traceId);
      return this.unknown(
        row,
        lease,
        signal,
        traceId,
        new Error('копия не найдена после копирования'),
      );
    }

    const rejection = this.target.validate(row, digest);
    if (rejection) {
      await this.markAttempt(attemptId, 'abandoned', rejection, traceId);
      return this.settle(row, lease, signal, traceId, 'rejected', rejection);
    }

    // 4. Публикация — одна транзакция; сигнал проверяется внутри неё.
    try {
      await this.change(traceId, signal, async (tx) => {
        const published = await completeUnderLease(tx, {
          table: this.target.table,
          lease,
          set: `upload_state = 'ready', upload_state_reason = NULL,
                upload_state_changed_at = now(), uploaded_at = now(),
                s3_key = $1, size_bytes = $2, content_hash = $3, content_type = $4,
                check_failures = 0, unknown_since = NULL, last_error = NULL,
                next_check_at = NULL`,
          params: [
            finalKey,
            digest.sizeBytes,
            `sha256:${digest.sha256}`,
            this.target.contentType(row, digest.head),
          ],
        });
        if (!published) throw new LeaseLost();
        await tx.query(
          `UPDATE ${this.target.attemptsTable}
              SET state = 'published', updated_at = now()
            WHERE id = $1 AND state = 'copied'`,
          [attemptId],
        );
        await this.target.emitPublished(tx, row, {
          sizeBytes: digest.sizeBytes,
          sha256: digest.sha256!,
          finalKey,
          executor: options.executor,
          actorId: options.actorId,
          traceId,
        });
      });
    } catch (error) {
      return stop(error) ?? this.unknown(row, lease, signal, traceId, error);
    }
    return { state: 'ready', received: true, busy: false, reason: null };
  }

  /** Работа прервана остановкой или потерей аренды: состояние прежнее. */
  private interrupted(row: UploadRow): CompletionOutcome {
    return {
      state: 'pending',
      received: row.object_received_at !== null,
      busy: true,
      reason: null,
    };
  }

  private async markAttempt(
    attemptId: string,
    state: 'copied' | 'failed' | 'abandoned',
    error: string | null,
    traceId: string,
  ): Promise<void> {
    await this.tx(traceId, (tx) =>
      tx.query(
        `UPDATE ${this.target.attemptsTable}
            SET state = $2, error = left($3, 500), updated_at = now()
          WHERE id = $1 AND state IN ('copying', 'copied')`,
        [attemptId, state, error],
      ),
    );
  }

  /** Объекта нет. До срока формы — ждём; после — отметка «к сроку не получен». */
  private async notYetReceived(
    row: UploadRow,
    lease: Lease,
    signal: AbortSignal,
    traceId: string,
  ): Promise<CompletionOutcome> {
    const expired = row.upload_expires_at !== null && row.upload_expires_at.getTime() < Date.now();
    const nextMs = expired ? UPLOAD_COMPLETION.expiredCheckMs : UPLOAD_COMPLETION.freshCheckMs;
    try {
      await this.change(traceId, signal, (tx) =>
        completeUnderLease(tx, {
          table: this.target.table,
          lease,
          set: `next_check_at = now() + make_interval(secs => $1),
                not_received_at = CASE WHEN $2 THEN coalesce(not_received_at, now())
                                       ELSE not_received_at END,
                check_failures = 0, unknown_since = NULL, last_error = NULL`,
          params: [nextMs / 1_000, expired],
        }),
      );
    } catch (error) {
      if (signal.aborted) return this.interrupted(row);
      throw error;
    }
    return { state: 'pending', received: false, busy: false, reason: null };
  }

  /**
   * Результат неизвестен: состояние не меняется, диагностика сохраняется,
   * повтор назначается по нарастающей паузе. Затянувшийся неизвестный
   * результат или серия неудач — «требует вмешательства». Вызывается только
   * для технических ошибок — прерывание сюда не попадает.
   */
  private async unknown(
    row: UploadRow,
    lease: Lease,
    signal: AbortSignal,
    traceId: string,
    error: unknown,
  ): Promise<CompletionOutcome> {
    const failures = row.check_failures + 1;
    const since = row.unknown_since ?? new Date();
    const message = errorText(error);
    const escalate =
      failures >= UPLOAD_COMPLETION.maxFailures ||
      Date.now() - since.getTime() >= UPLOAD_COMPLETION.maxUnknownMs;
    this.logger.error({
      msg: escalate
        ? 'загрузка требует вмешательства: результат неизвестен слишком долго'
        : 'завершение загрузки не выполнено, результат неизвестен',
      uploadId: row.id,
      failures,
      unknownSince: since.toISOString(),
      error: message,
    });
    if (escalate) {
      return this.settle(
        row,
        lease,
        signal,
        traceId,
        'needs_attention',
        `результат неизвестен: ${failures} неудач подряд с ${since.toISOString()}`,
        message,
      );
    }
    try {
      await this.change(traceId, signal, (tx) =>
        completeUnderLease(tx, {
          table: this.target.table,
          lease,
          set: `check_failures = $1, unknown_since = $2, last_error = left($3, 500),
                next_check_at = now() + make_interval(secs => $4)`,
          params: [failures, since, message, failureBackoffMs(failures) / 1_000],
        }),
      );
    } catch {
      if (signal.aborted) return this.interrupted(row);
      // Записать диагностику не удалось — запись остаётся «ожидает», аренда
      // истечёт, сверка повторит.
    }
    return {
      state: 'pending',
      received: row.object_received_at !== null,
      busy: false,
      reason: null,
    };
  }

  /** Окончательное состояние без публикации: «отклонено» или «требует вмешательства». */
  private async settle(
    row: UploadRow,
    lease: Lease,
    signal: AbortSignal,
    traceId: string,
    state: 'rejected' | 'needs_attention',
    reason: string,
    lastError: string | null = null,
  ): Promise<CompletionOutcome> {
    let settled: boolean;
    try {
      settled = await this.change(traceId, signal, (tx) =>
        completeUnderLease(tx, {
          table: this.target.table,
          lease,
          set: `upload_state = $1, upload_state_reason = left($2, 500),
                upload_state_changed_at = now(), next_check_at = NULL,
                last_error = coalesce(left($3, 500), last_error)`,
          params: [state, reason, lastError],
        }),
      );
    } catch (error) {
      if (signal.aborted) return this.interrupted(row);
      throw error;
    }
    if (!settled) return this.interrupted(row);
    if (state === 'needs_attention') {
      this.logger.error({ msg: 'загрузка требует вмешательства', uploadId: row.id, reason });
    }
    return { state, received: row.object_received_at !== null, busy: false, reason };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
