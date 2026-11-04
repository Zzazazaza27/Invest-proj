import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../config/env';

/**
 * CSRF-токен, СВЯЗАННЫЙ с сессией.
 *
 * Прежняя схема — «double submit»: случайное значение клали в читаемую cookie и
 * требовали то же значение в заголовке. Слабое место названо в внешнем аудите
 * (SEC-12): токен ни с чем не связан, поэтому тот, кто СМОЖЕТ поставить жертве
 * свою cookie (перехваченный поддомен, dns takeover, небезопасный сосед по
 * домену), подставит согласованную пару cookie+заголовок и пройдёт проверку.
 *
 * Здесь токен подписан: `nonce.HMAC(ключ, subject + nonce)`. Значение остаётся
 * читаемым для фронтенда (он обязан положить его в заголовок), но НЕ может быть
 * изготовлено под чужую сессию: без ключа сервера подпись не вычисляется, а с
 * чужим `subject` не сходится.
 *
 * Что схема по-прежнему НЕ закрывает: кражу самого токена вместе с сессией.
 * Это другой класс угрозы (XSS), и лечится он не здесь.
 */
const CSRF_CONTEXT = 'fifth-csrf.v1';

export function issueCsrfToken(subject: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return `${nonce}.${signCsrf(subject, nonce)}`;
}

/**
 * Проверка токена для конкретной сессии.
 *
 * Возвращает false при любом несоответствии — форма, подпись, чужой владелец.
 * Причина наружу не сообщается: по разнице ответов подбирается формат.
 */
export function isCsrfTokenValid(subject: string, token: string): boolean {
  const [nonce, signature] = token.split('.');
  if (!nonce || !signature) return false;

  const expected = Buffer.from(signCsrf(subject, nonce), 'base64url');
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function signCsrf(subject: string, nonce: string): string {
  // Свой ключ, а не ключ сессий: тот проверяется на длину только при
  // AUTH_MODE=local и в production может быть пустым — ровно та ошибка, что
  // нашлась в подписи сервисных токенов (SEC-01). Повторять её нельзя.
  return createHmac('sha256', getEnv().CSRF_SIGNING_KEY)
    .update(`${CSRF_CONTEXT}.${subject}.${nonce}`)
    .digest('base64url');
}
