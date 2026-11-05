import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { issuingKey, joinSigned, signedText, splitSigned, verifyingSecret } from './signing-keys';

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
  const { kid, secret } = issuingKey('CSRF_SIGNING_KEY');
  return joinSigned(kid, nonce, signCsrf(secret, subject, signedText(kid, nonce)));
}

/**
 * Проверка токена для конкретной сессии.
 *
 * Возвращает false при любом несоответствии — форма, подпись, чужой владелец.
 * Причина наружу не сообщается: по разнице ответов подбирается формат.
 */
export function isCsrfTokenValid(subject: string, token: string): boolean {
  const split = splitSigned(token);
  if (!split) return false;
  const key = verifyingSecret('CSRF_SIGNING_KEY', split.kid);
  if (key === null) return false;
  const [nonce, signature] = split.parts;

  const expected = Buffer.from(signCsrf(key, subject, signedText(split.kid, nonce)), 'base64url');
  const provided = Buffer.from(signature, 'base64url');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function signCsrf(secret: string, subject: string, nonce: string): string {
  // Свой ключ, а не ключ сессий: тот проверяется на длину только при
  // AUTH_MODE=local и в production может быть пустым — ровно та ошибка, что
  // нашлась в подписи сервисных токенов (SEC-01). Повторять её нельзя.
  return createHmac('sha256', secret)
    .update(`${CSRF_CONTEXT}.${subject}.${nonce}`)
    .digest('base64url');
}
