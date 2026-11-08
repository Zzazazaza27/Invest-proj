/**
 * Ошибки интерфейса — техническая диагностика (блок 8, 8.4; план принят 09.11.2026).
 *
 * Состав минимальный: кабинет, экран, версия, постоянный код, этап, ID запроса, размер
 * окна и число повторов. Текст ошибки, стек, URL, содержимое форм и ID пользователя не
 * собираются. Это не аналитика (3.6).
 *
 * Каждое строковое поле — из ЗАКРЫТОГО перечня: проверки символов мало, строка из
 * разрешённых букв всё равно может нести чужие данные. Один перечень служит и клиенту
 * (что вправе отправить), и серверу (что вправе принять).
 */

export const CLIENT_ERROR_CABINETS = [
  'lab',
  'investor',
  'admin',
  'auth',
  'console',
  'public',
] as const;
export type ClientErrorCabinet = (typeof CLIENT_ERROR_CABINETS)[number];

/** Экран — шаблон маршрута кабинета (без базового пути); не узнан — `other`. */
export const CLIENT_ERROR_SCREENS: Readonly<Record<ClientErrorCabinet, readonly string[]>> = {
  lab: ['/', '/projects/:id', '/profile', '/glossary'],
  investor: ['/'],
  admin: [
    '/',
    '/users',
    '/users/:id',
    '/compliance',
    '/templates',
    '/support',
    '/support/:id',
    '/integrations',
    '/texts',
    '/service-countries',
    '/flags',
    '/testing',
    '/ui',
    '/access',
    '/intelligence',
    '/intelligence/sources',
    '/intelligence/sources/:id',
    '/intelligence/:id',
  ],
  auth: ['/'],
  console: ['/'],
  public: ['/', '/p/:id'],
};
export const CLIENT_ERROR_OTHER_SCREEN = 'other';

export const CLIENT_ERROR_CODES = [
  /** Необработанное исключение (`error`). */
  'js.uncaught',
  /** Необработанный отказ промиса (`unhandledrejection`). */
  'js.rejection',
  /** Не загрузилась часть приложения (после выкладки новой версии и т. п.). */
  'chunk.load_failed',
  /** Граница ошибок React перехватила отказ отрисовки. */
  'render.boundary',
  /** Ответ API 5xx. */
  'api.server_error',
  /** Сеть или прокси: ответа ядра нет, исход неизвестен. */
  'api.unavailable',
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export const CLIENT_ERROR_STAGES = ['load', 'render', 'request', 'navigate', 'unknown'] as const;
export type ClientErrorStage = (typeof CLIENT_ERROR_STAGES)[number];

export const CLIENT_ERROR_LIMITS = {
  /** Предел тела сообщения, байт. */
  maxBodyBytes: 2048,
  /** Предел числа повторов в одном сообщении. */
  maxCount: 1000,
  /** Предел стороны окна, CSS-пикселей. */
  maxViewport: 20000,
  /** Сообщений с одной загрузки страницы. */
  maxReportsPerPage: 10,
} as const;

/** Версия — короткий или полный hash коммита либо `unknown` (сборка без git). */
const VERSION = /^(?:[0-9a-f]{7,40}|unknown)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ClientErrorReport {
  cabinet: ClientErrorCabinet;
  screen: string;
  version: string;
  code: ClientErrorCode;
  stage: ClientErrorStage;
  requestId?: string;
  viewportWidth?: number;
  viewportHeight?: number;
  count: number;
}

const FIELDS = new Set([
  'cabinet',
  'screen',
  'version',
  'code',
  'stage',
  'requestId',
  'viewportWidth',
  'viewportHeight',
  'count',
]);

/**
 * Разбор сообщения. Неизвестные поля отбрасываются, наружу — только ИХ ЧИСЛО: имя поля
 * само может нести почту или токен, поэтому ни имён, ни значений нет ни в результате, ни
 * в причине отказа. Отказ — без указания поля.
 */
export type ClientErrorParse =
  { ok: true; report: ClientErrorReport; dropped: number } | { ok: false };

export function parseClientErrorReport(input: unknown): ClientErrorParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false };
  const raw = input as Record<string, unknown>;
  let dropped = 0;
  for (const key of Object.keys(raw)) if (!FIELDS.has(key)) dropped += 1;

  const cabinet = raw.cabinet;
  if (!isOneOf(CLIENT_ERROR_CABINETS, cabinet)) return { ok: false };
  const screen = raw.screen;
  if (
    typeof screen !== 'string' ||
    (screen !== CLIENT_ERROR_OTHER_SCREEN && !CLIENT_ERROR_SCREENS[cabinet].includes(screen))
  ) {
    return { ok: false };
  }
  if (typeof raw.version !== 'string' || !VERSION.test(raw.version)) return { ok: false };
  if (!isOneOf(CLIENT_ERROR_CODES, raw.code)) return { ok: false };
  if (!isOneOf(CLIENT_ERROR_STAGES, raw.stage)) return { ok: false };
  if (!isInt(raw.count, 1, CLIENT_ERROR_LIMITS.maxCount)) return { ok: false };

  const report: ClientErrorReport = {
    cabinet,
    screen,
    version: raw.version,
    code: raw.code,
    stage: raw.stage,
    count: raw.count,
  };
  if (raw.requestId !== undefined) {
    if (typeof raw.requestId !== 'string' || !UUID.test(raw.requestId)) return { ok: false };
    report.requestId = raw.requestId;
  }
  for (const side of ['viewportWidth', 'viewportHeight'] as const) {
    const value = raw[side];
    if (value === undefined) continue;
    if (!isInt(value, 0, CLIENT_ERROR_LIMITS.maxViewport)) return { ok: false };
    report[side] = value;
  }
  return { ok: true, report, dropped };
}

/**
 * Экран по пути внутри кабинета: совпадение с шаблоном (`:id` — один сегмент), иначе
 * `other`. Сам путь наружу не уходит.
 */
export function clientErrorScreen(cabinet: ClientErrorCabinet, path: string): string {
  const clean = path.split(/[?#]/)[0]!.replace(/\/+$/, '') || '/';
  const parts = clean.split('/');
  for (const pattern of CLIENT_ERROR_SCREENS[cabinet]) {
    const want = pattern.split('/');
    if (want.length !== parts.length) continue;
    if (want.every((seg, i) => (seg.startsWith(':') ? parts[i] !== '' : seg === parts[i]))) {
      return pattern;
    }
  }
  return CLIENT_ERROR_OTHER_SCREEN;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}
