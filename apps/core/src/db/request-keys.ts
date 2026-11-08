import { createHash } from 'node:crypto';
import { errors } from '../common/errors';
import type { Database, RequestContext, Tx } from './unit-of-work';

/**
 * Ключ повтора изменяющей операции (блок 2, 2.6; M159).
 *
 * Клиент создаёт ключ до первой отправки и повторяет его, пока результат не выяснен. Сервер
 * записывает ключ В ТОЙ ЖЕ транзакции, что и изменение, ПЕРВЫМ действием:
 *
 *   * второй запрос с тем же ключом ждёт на уникальном индексе, пока первая транзакция не
 *     завершится; ожидание ограничено (LOCK_WAIT_MS) — дальше ответ «выполняется», без
 *     разрыва атомарности изменения и результата;
 *   * первая зафиксировалась — второй получает прежний результат, прочитанный заново с
 *     текущими правами;
 *   * первая откатилась — строки нет, второй выполняет работу сам: ни ложного успеха, ни
 *     вечной блокировки ключа.
 *
 * Объект операции (проект, обращение) входит в отпечаток: тот же ключ для другого объекта —
 * конфликт, а не чужой результат.
 */
export type GuardedOperation =
  'lab.project.create' | 'lab.material.link' | 'support.ticket.open' | 'support.message.add';

export interface RequestKey {
  key: string;
  operation: GuardedOperation;
  /** Объект, над которым операция: проект для ссылки, обращение для сообщения. */
  objectId: string | null;
  /** Существенное содержимое запроса: то, что меняет результат. */
  payload: unknown;
}

/** Окно повтора первого пакета (Тэнк 08.11). Очистки нет: просроченный ключ — явный отказ. */
export const KEY_WINDOW = '7 days';
/** Сколько второй запрос ждёт первый, прежде чем ответить «выполняется». */
export const LOCK_WAIT_MS = 3000;
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Ключ из заголовка `Idempotency-Key`. Нет заголовка — операция идёт без защиты, как
 * раньше (служебные клиенты и проверки). Есть, но неверный — отказ: молча проигнорировать
 * означало бы обещать клиенту защиту, которой нет.
 */
export function requestKeyFrom(header: unknown): string | null {
  if (header === undefined) return null;
  if (typeof header !== 'string' || !KEY_RE.test(header)) {
    throw errors.validation([
      { path: 'Idempotency-Key', message: '16–128 символов A-Z a-z 0-9 _ -' },
    ]);
  }
  return header;
}

/** Канонический JSON: порядок полей не меняет отпечаток. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestHash(rk: Omit<RequestKey, 'key'>): Buffer {
  return createHash('sha256')
    .update(canonical({ operation: rk.operation, objectId: rk.objectId, payload: rk.payload }))
    .digest();
}

/**
 * Занять ключ первым действием транзакции. `resultId` — идентификатор, который получит
 * результат этой работы; вызывающий создаёт его заранее.
 *
 * Возвращает `null` — работа новая, выполнять; строку — идентификатор прежнего результата:
 * работу не выполнять, прочитать результат заново с текущими правами.
 */
export async function claimRequestKey(
  tx: Tx,
  ctx: RequestContext,
  rk: RequestKey,
  resultId: string,
): Promise<string | null> {
  if (!ctx.userId) throw errors.unauthenticated();
  const hash = requestHash(rk);
  const { rows: before } = await tx.query<{ lock_timeout: string }>('SHOW lock_timeout');
  await tx.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
  let inserted: boolean;
  try {
    const { rowCount } = await tx.query(
      `INSERT INTO requests.idempotency_keys
         (actor_id, operation, key, object_id, request_hash, result_id, expires_at)
       VALUES (app.current_user_id(), $1, $2, $3, $4, $5, now() + $6::interval)
       ON CONFLICT (actor_id, operation, key) DO NOTHING`,
      [rk.operation, rk.key, rk.objectId, hash, resultId, KEY_WINDOW],
    );
    inserted = rowCount === 1;
  } catch (error) {
    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE)
      throw errors.operationInProgress();
    throw error;
  }
  await tx.query('SELECT set_config($1, $2, true)', [
    'lock_timeout',
    before[0]?.lock_timeout ?? '0',
  ]);
  if (inserted) return null;

  const { rows } = await tx.query<{
    object_id: string | null;
    request_hash: Buffer;
    result_id: string;
    expired: boolean;
  }>(
    `SELECT object_id, request_hash, result_id, expires_at <= now() AS expired
       FROM requests.idempotency_keys
      WHERE actor_id = app.current_user_id() AND operation = $1 AND key = $2`,
    [rk.operation, rk.key],
  );
  const row = rows[0];
  // Строка есть (вставка не прошла), но не видна — так быть не должно: политика отдаёт свои.
  if (!row) throw errors.operationInProgress();
  if (row.object_id !== rk.objectId || !row.request_hash.equals(hash)) {
    throw errors.idempotencyKeyReused();
  }
  if (row.expired) throw errors.idempotencyKeyExpired();
  return row.result_id;
}

export type RequestKeyState =
  { state: 'done'; resultId: string; objectId: string | null } | { state: 'absent' };

/** Откат пробной транзакции с ответом: изменений состояние не делает. */
class ProbeAnswer {
  constructor(readonly answer: RequestKeyState) {}
}

/**
 * Состояние отправки по ключу — без её содержимого (вкладка после повторного входа или
 * перезагрузки помнит только ключ). Только чтение: пробная вставка того же ключа
 * откатывается всегда.
 *
 *   * ключ зафиксирован — `done` и идентификатор результата; сам результат клиент читает
 *     обычным маршрутом, где права проверяются заново;
 *   * транзакция с этим ключом ещё идёт — «выполняется» (ожидание не дольше LOCK_WAIT_MS);
 *   * ключа нет и он ничем не занят — `absent`: отправка не дошла, ничего не записано.
 *
 * Свои ключи видны только своему пользователю (RLS): чужой ключ даёт `absent`, как
 * несуществующий.
 */
export async function requestKeyState(
  db: Database,
  ctx: RequestContext,
  operation: GuardedOperation,
  key: string,
): Promise<RequestKeyState> {
  try {
    await db.transaction(ctx, async (tx) => {
      await tx.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
      let inserted: boolean;
      try {
        const { rowCount } = await tx.query(
          `INSERT INTO requests.idempotency_keys
             (actor_id, operation, key, object_id, request_hash, result_id, expires_at)
           VALUES (app.current_user_id(), $1, $2, NULL, $3, gen_random_uuid(), now())
           ON CONFLICT (actor_id, operation, key) DO NOTHING`,
          [operation, key, Buffer.alloc(32)],
        );
        inserted = rowCount === 1;
      } catch (error) {
        if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) {
          throw errors.operationInProgress();
        }
        throw error;
      }
      if (inserted) throw new ProbeAnswer({ state: 'absent' });
      const { rows } = await tx.query<{ result_id: string; object_id: string | null }>(
        `SELECT result_id, object_id FROM requests.idempotency_keys
          WHERE actor_id = app.current_user_id() AND operation = $1 AND key = $2`,
        [operation, key],
      );
      const row = rows[0];
      throw new ProbeAnswer(
        row
          ? { state: 'done', resultId: row.result_id, objectId: row.object_id }
          : { state: 'absent' },
      );
    });
  } catch (signal) {
    if (signal instanceof ProbeAnswer) return signal.answer;
    throw signal;
  }
  throw new Error('пробная транзакция завершилась без ответа');
}
