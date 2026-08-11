import { ApiError, UnicornApi } from '@unicorn/api-client';

/**
 * Единственное место кабинета, которое знает про HTTP.
 *
 * Адрес API берётся от ТОГО ЖЕ хоста, на котором открыта страница. Зашитый
 * `127.0.0.1` был бы ловушкой: страница, открытая как `localhost`, обращалась
 * бы к другому сайту с точки зрения браузера — сессионная cookie на такой
 * запрос не отправляется, и это выглядит как «вход не работает» при исправном
 * сервере (проверено рендером в Ф10a).
 */
const BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  `${window.location.protocol}//${window.location.hostname}:4300/v1`;

/**
 * Имя CSRF-cookie зависит от окружения: в production действует префикс
 * `__Host-`, вне его — обычное имя (браузер отбрасывает `__Host-`-cookie,
 * поставленную без Secure по http). Проверяются оба варианта: рассинхрон имени
 * тихо ломает все небезопасные запросы после перезагрузки страницы.
 */
const CSRF_COOKIE_NAMES = [
  (import.meta.env.VITE_CSRF_COOKIE_NAME as string | undefined) ?? 'ul_csrf',
  '__Host-ul_csrf',
];

export function readCsrfCookie(): string | null {
  for (const name of CSRF_COOKIE_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const match = new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`).exec(document.cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

export const api = new UnicornApi({
  baseUrl: BASE_URL,
  // Токен сессии живёт в httpOnly-cookie и этому коду недоступен: сюда попадает
  // только CSRF-токен по схеме double-submit.
  auth: { kind: 'cookie', csrfToken: readCsrfCookie() },
  timeoutMs: 15_000,
});

/** После входа сервер отдаёт свежий CSRF-токен в теле — cookie может отстать. */
export function setCsrf(token: string | null): void {
  api.http.setCsrfToken(token ?? readCsrfCookie());
}

export { ApiError };
