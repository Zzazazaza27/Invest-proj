import { uuidv7 } from '@fifth/contracts';
import { ApiError } from './client';

/**
 * Удержание ключа повтора в форме (блок 2, 2.6).
 *
 * Ключ создаётся до первой отправки. Если исход стал неизвестен (ответ потерян, нечитаем),
 * ключ держится до ПОДТВЕРЖДЁННОГО завершения: успешного ответа или явного решения
 * человека начать заново. Промежуточный отказ проверки — «выполняется», временная
 * недоступность, ограничение частоты, сеть — исход прежней операции не делает известным и
 * ключа не снимает. Иначе следующее нажатие пошло бы с новым ключом и могло выполнить
 * операцию второй раз (вторая ротация секрета, второй аккаунт).
 *
 * Ключ снимается после отказа только когда исход ещё не был неизвестен и отказ
 * окончательный (например, ошибка проверки полей на первой отправке): ничего не записано.
 */
export interface RetryKey {
  key: string;
  /** Исход отправки с этим ключом неизвестен: снимать ключ можно только по завершении. */
  unresolved: boolean;
}

/** Ключ для очередной отправки: прежний, если он есть, иначе новый. */
export function keyForSend(current: RetryKey | null): RetryKey {
  return current ?? { key: uuidv7(), unresolved: false };
}

/** Отказ не разрешает исход: результат мог быть записан или ещё записывается. */
export function leavesOutcomeOpen(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.outcomeUnknown) return true;
  if (error.code === 'operation_in_progress') return true;
  return [0, 429, 502, 503, 504].includes(error.status);
}

/** После успешного ответа — ключа нет: операция завершена. */
export function keyAfterSuccess(): null {
  return null;
}

/** После отказа: держать ключ, если исход был или остаётся неизвестным. */
export function keyAfterError(current: RetryKey, error: unknown): RetryKey | null {
  if (current.unresolved || leavesOutcomeOpen(error)) return { key: current.key, unresolved: true };
  return null;
}
