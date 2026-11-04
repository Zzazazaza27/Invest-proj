import { ApiError, FifthApi } from '@fifth/api-client';
import {
  adoptTestContextFromUrl,
  setContextFileResolver,
  type TestContextPort,
} from '@fifth/cabinet';

/**
 * Единственное место кабинета, которое знает про HTTP.
 *
 * Адрес API берётся от ТОГО ЖЕ хоста, на котором открыта страница. Зашитый
 * `127.0.0.1` был бы ловушкой: страница, открытая как `localhost`, обращалась
 * бы к другому сайту с точки зрения браузера — сессионная cookie на такой
 * запрос не отправляется, и это выглядит как «вход не работает» при исправном
 * сервере (проверено рендером в Ф10a).
 */
/**
 * Адрес API.
 *
 * Порта в адресе страницы нет — значит приложение раздаётся через единую точку
 * входа, и API живёт на том же origin по пути `/v1`. Тогда относительный адрес
 * не просто короче: он избавляет от списка разрешённых origin в CORS и не
 * требует пересборки под каждый домен.
 *
 * Порт есть — это прямой запуск dev-сервером, и ядро слушает отдельный порт.
 */
/**
 * ЕДИНАЯ ТОЧКА ВХОДА ПОБЕЖДАЕТ ПЕРЕМЕННУЮ СБОРКИ.
 *
 * `VITE_API_BASE_URL` в `.env` задан абсолютным (`http://localhost:4300/v1`)
 * ради прямого запуска dev-серверами. Для собранной статики, которую nginx
 * раздаёт с `127.0.0.1`, этот адрес — ДРУГОЙ origin: вход проходит (201), а
 * следующий запрос получает 401, потому что cookie межсайтово не уходит.
 * Снаружи это выглядит как «кабинет не пускает», и причину ищут в
 * авторизации.
 *
 * Поэтому решает не переменная, а то, как открыта страница: порта в адресе
 * нет — значит единая точка входа, и API живёт на том же origin. Переменная
 * нужна только там, где порт есть, то есть при прямом запуске dev-сервером.
 */
const BASE_URL =
  window.location.port === ''
    ? '/v1'
    : ((import.meta.env.VITE_API_BASE_URL as string | undefined) ??
      `${window.location.protocol}//${window.location.hostname}:4300/v1`);

/**
 * Адрес API обязателен всюду, кроме локальной машины.
 *
 * Молчаливый переход на `hostname:4300` на реальном домене увёл бы
 * приложение на порт того же хоста по http — сессионная cookie ушла бы в
 * открытый канал (LOW внешнего аудита №2). Поэтому на не-локальном хосте это
 * ошибка запуска, а не «работает как-нибудь».
 *
 * Условие смотрит и на ПОРТ: пустой порт означает единую точку входа —
 * API там на том же origin по пути `/v1`, и угадывать нечего. Опасен
 * именно случай, когда приложение вынуждено подставить чужой порт.
 *
 * Проверяется ХОСТ, а не `import.meta.env.PROD`: локальные
 * браузерные прогоны поднимают ровно production-сборку, и жёсткая проверка
 * по PROD ломала бы их, ничего не защищая — на localhost адрес и так
 * локальный.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
if (
  !import.meta.env.VITE_API_BASE_URL &&
  window.location.port !== '' &&
  !LOCAL_HOSTS.has(window.location.hostname)
) {
  throw new Error('VITE_API_BASE_URL обязателен: адрес API не может выводиться из адреса страницы');
}

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

export const api = new FifthApi({
  baseUrl: BASE_URL,
  // Токен сессии живёт в httpOnly-cookie и этому коду недоступен: сюда попадает
  // только CSRF-токен по схеме double-submit.
  auth: { kind: 'cookie', csrfToken: readCsrfCookie() },
  timeoutMs: 15_000,
});

/** После входа сервер отдаёт свежий CSRF-токен в теле — cookie может отстать. */
export function setCsrf(token: string | null): void {
  // `null` означает СБРОС (выход из системы), а не «перечитай cookie»:
  // прежний код после logout подхватывал ещё не удалённую браузером cookie
  // и оставлял клиент с токеном уже закрытой сессии. В admin это было
  // сделано правильно с самого начала — расхождение копий (аудит №2).
  if (token === null) {
    api.http.setCsrfToken(null);
    return;
  }
  api.http.setCsrfToken(token || readCsrfCookie());
}

/**
 * Контекст тестовой вкладки (M129).
 *
 * Читается ОДИН раз при загрузке модуля — до первого запроса: иначе первые
 * обращения кабинета ушли бы от имени администратора, и экран показал бы
 * чужие данные ещё до того, как контекст применился.
 */
export const testContextId = adoptTestContextFromUrl();
if (testContextId) api.http.setAccessContext(testContextId);

/**
 * Порт панели. Завершение просмотра — действие АДМИНИСТРАТОРА: запрос уходит
 * без заголовка контекста, под обычной административной сессией.
 */
// Картинки в тестовой вкладке забираются тем же клиентом, что и данные:
// иначе браузер запросит их сам, без заголовка контекста.
setContextFileResolver((path) => api.http.resolveFileUrl(path));

export const testContextPort: TestContextPort = {
  current: async () => {
    try {
      return await api.testing.currentContext();
    } catch {
      return null;
    }
  },
  close: async (contextId: string) => {
    const previous = api.http.accessContext;
    api.http.setAccessContext(null);
    try {
      await api.testing.closeContext(contextId);
    } finally {
      api.http.setAccessContext(previous);
    }
  },
  adminUrl: '/admin/',
};

export { ApiError };

/**
 * Адрес изображения проекта.
 *
 * Сервер отдаёт путь относительно API. При запуске dev-сервером страница и
 * ядро живут на разных портах, и относительный путь увёл бы браузер в кабинет
 * вместо ядра.
 */
export function mediaUrl(path: string): string {
  if (path === '' || /^https?:/i.test(path)) return path;
  return `${BASE_URL.replace(/\/v1$/, '')}${path}`;
}
