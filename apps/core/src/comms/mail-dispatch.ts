import { createHash, randomUUID } from 'node:crypto';
import { uuidv7 } from '@fifth/contracts';
import { mailBreaker } from '../availability/mail-health';
import { getEnv } from '../config/env';
import type { Tx } from '../db/unit-of-work';
import type { MailMessage, MailOutcome, MailTransport } from './mail.transport';

/**
 * Отметки отправки писем со ссылкой (4.11, M162): смена пароля и подтверждение адреса.
 *
 * SMTP нельзя сделать атомарным с записью в БД, и помещение диалога с релеем внутрь
 * транзакции этого не меняет. Поэтому:
 *
 *   1. в ОДНОЙ транзакции с выдачей ссылки фиксируется «отправка начата» (`started` со
 *      сроком `started_until`); ссылка в запись не попадает — она живёт только в письме;
 *   2. после фиксации — диалог с релеем;
 *   3. отдельной записью — исход: принято релеем / точно не ушло / неизвестно.
 *
 * Процесс упал между 1 и 3 (в том числе после того, как релей уже принял письмо) — запись
 * остаётся `started`; после срока она читается как «неизвестно». Повтор тем же ключом
 * письмо не отправляет ни в этом случае, ни при `accepted` и `unknown`. Заново — только
 * после «точно не ушло».
 */
export type DispatchState = 'started' | 'accepted' | 'not_sent' | 'unknown' | 'skipped';
export type DispatchPurpose = 'password_reset' | 'email_verify';

/** Окно повтора ключа — как у ключей M159. */
const KEY_WINDOW_DAYS = 7;

export interface DispatchClaim {
  id: string;
  /** Работу можно начинать: запись новая или прежняя попытка точно не ушла. */
  mayStart: boolean;
  /** Ключ прислан с другим содержимым запроса. */
  sameRequest: boolean;
  expired: boolean;
  /** Состояние прежней попытки (для новой — `skipped`). */
  state: DispatchState;
  createdAt: Date;
}

export const keyHash = (purpose: DispatchPurpose, key: string): Buffer =>
  createHash('sha256').update(`mail-dispatch:${purpose}:${key}`).digest();

export const digest = (value: Buffer | string): Buffer =>
  createHash('sha256').update(value).digest();

/** Без заголовка `Idempotency-Key` — разовый ключ: защиты от повтора нет, отметка начала есть. */
export const oneOffKey = (): string => randomUUID().replaceAll('-', '');

/** Сколько ждать исхода начатой отправки, прежде чем считать её неизвестной. */
export function startedWindowSeconds(): number {
  // Предел — на каждую фазу диалога (соединение, приветствие, EHLO, TLS, EHLO, вход, MAIL,
  // RCPT, DATA, текст): с запасом на десять фаз и ещё полминуты.
  return Math.ceil((getEnv().MAIL_SMTP_TIMEOUT_MS * 10) / 1000) + 30;
}

/**
 * Занять ключ первым действием транзакции. Второй такой же запрос ждёт на уникальном индексе,
 * пока первая транзакция не завершится, затем видит её запись.
 */
export async function claimDispatch(
  tx: Tx,
  input: {
    purpose: DispatchPurpose;
    scope: 'anonymous' | 'user';
    keyHash: Buffer;
    requestHash: Buffer;
  },
): Promise<DispatchClaim> {
  const actor = input.scope === 'user' ? 'app.current_user_id()' : 'NULL';
  const id = uuidv7();
  const { rows: inserted } = await tx.query<{ created_at: Date }>(
    `INSERT INTO comms.mail_dispatches
       (id, purpose, scope, actor_id, key_hash, request_hash, state, expires_at)
     VALUES ($1, $2, $3, ${actor}, $4, $5, 'skipped', now() + make_interval(days => $6))
     ON CONFLICT DO NOTHING
     RETURNING created_at`,
    [id, input.purpose, input.scope, input.keyHash, input.requestHash, KEY_WINDOW_DAYS],
  );
  if (inserted[0]) {
    return {
      id,
      mayStart: true,
      sameRequest: true,
      expired: false,
      state: 'skipped',
      createdAt: inserted[0].created_at,
    };
  }
  const { rows } = await tx.query<{
    id: string;
    state: DispatchState;
    request_hash: Buffer;
    expired: boolean;
    stale: boolean;
    created_at: Date;
  }>(
    `SELECT id, state, request_hash, expires_at <= now() AS expired,
            (state = 'started' AND started_until < now()) AS stale, created_at
       FROM comms.mail_dispatches
      WHERE purpose = $1 AND scope = $2 AND key_hash = $3
        AND actor_id IS NOT DISTINCT FROM ${actor}
      FOR UPDATE`,
    [input.purpose, input.scope, input.keyHash],
  );
  const row = rows[0];
  if (!row) throw new Error('ключ отправки занят, но запись не видна');
  let state = row.state;
  if (row.stale) {
    // Начатая отправка не завершилась за отведённое время — процесс упал или потерял связь
    // с БД. Релей мог принять письмо: это «неизвестно», а не «не ушло».
    await tx.query(
      `UPDATE comms.mail_dispatches
          SET state = 'unknown', started_until = NULL, finished_at = now()
        WHERE id = $1 AND state = 'started'`,
      [row.id],
    );
    state = 'unknown';
  }
  const sameRequest = row.request_hash.equals(input.requestHash);
  return {
    id: row.id,
    mayStart: sameRequest && !row.expired && state === 'not_sent',
    sameRequest,
    expired: row.expired,
    state,
    createdAt: row.created_at,
  };
}

/** Устойчивая отметка «внешняя отправка начата» — в транзакции выдачи ссылки. */
export async function markStarted(tx: Tx, id: string): Promise<void> {
  await tx.query(
    `UPDATE comms.mail_dispatches
        SET state = 'started', finished_at = NULL,
            started_until = now() + make_interval(secs => $2)
      WHERE id = $1`,
    [id, startedWindowSeconds()],
  );
}

/** Письма не было (адреса нет, превышен счётчик): наружу неотличимо, повтор ключом ничего не шлёт. */
export async function markSkipped(tx: Tx, id: string): Promise<void> {
  await tx.query(
    `UPDATE comms.mail_dispatches SET state = 'skipped', started_until = NULL, finished_at = now()
      WHERE id = $1`,
    [id],
  );
}

/** Исход отправки — отдельной записью после диалога с релеем. */
export async function markFinished(tx: Tx, id: string, outcome: MailOutcome): Promise<void> {
  const state: DispatchState =
    outcome.outcome === 'accepted'
      ? 'accepted'
      : outcome.outcome === 'unknown'
        ? 'unknown'
        : 'not_sent';
  await tx.query(
    `UPDATE comms.mail_dispatches
        SET state = $2, started_until = NULL, finished_at = now()
      WHERE id = $1 AND state = 'started'`,
    [id, state],
  );
}

/**
 * Отправка с учётом в размыкателе «Почты». Исключение транспорта (канал не настроен,
 * ошибка сборки письма) — «точно не ушло» по вине канала.
 */
export async function sendTracked(mail: MailTransport, message: MailMessage): Promise<MailOutcome> {
  let outcome: MailOutcome;
  try {
    outcome = await mail.send(message);
  } catch {
    outcome = { outcome: 'not_sent', scope: 'transport', stage: 'config', code: null };
  }
  const channelOk =
    outcome.outcome === 'accepted' ||
    (outcome.outcome === 'not_sent' && outcome.scope === 'message');
  mailBreaker().record('write', channelOk);
  return outcome;
}
