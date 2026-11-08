import { createClientErrorReporter, reportApiFailure } from '@fifth/cabinet';
import { FifthApi } from '@fifth/api-client';

/**
 * Единственная точка связи витрины с бэкендом.
 *
 * Витрина анонимна: ни сессии, ни токена здесь нет и быть не должно — всё, что
 * она показывает, доступно публично по построению (тексты витрины и тизеры
 * листингов). Появление здесь аутентификации означало бы, что витрина
 * начала показывать чужие данные.
 */
/**
 * Порта в адресе страницы нет — витрина раздаётся через единую точку входа, и
 * API живёт на том же origin по пути `/v1`. Порт есть — прямой запуск
 * dev-сервером, и ядро слушает отдельный порт.
 */
const baseUrl =
  import.meta.env.VITE_API_BASE_URL ??
  (window.location.port === ''
    ? '/v1'
    : `${window.location.protocol}//${window.location.hostname}:4300/v1`);

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


declare const __APP_VERSION__: string;

// Ошибки интерфейса (8.4): только перечень полей, одна попытка, без повторов.
createClientErrorReporter({
  cabinet: 'public',
  version: __APP_VERSION__,
  apiBaseUrl: baseUrl,
  basePath: import.meta.env.BASE_URL,
});

export const api = new FifthApi({
  baseUrl,
  onFailure: reportApiFailure,
  auth: { kind: 'none' },
  // Витрина — первое, что видит человек. Запрос, висящий дольше десяти секунд,
  // для него неотличим от сломанного сайта.
  timeoutMs: 10_000,
});

export { ApiError } from '@fifth/api-client';

/**
 * Адрес изображения проекта.
 *
 * Сервер отдаёт путь вида `/v1/projects/.../media/...` — он относителен API, а
 * не страницы. При прямом запуске dev-сервером страница и API живут на разных
 * портах, и относительный путь увёл бы браузер на витрину вместо ядра.
 */
export function mediaUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base = baseUrl.replace(/\/v1$/, '');
  return `${base}${path}`;
}
