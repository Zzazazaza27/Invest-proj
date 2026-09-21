import {
  ErrorCode,
  ProblemDetailsSchema,
  type ErrorCodeValue,
  type ProblemDetails,
} from '@unicorn/contracts';
import type { z } from 'zod';

/**
 * Транспорт /v1.
 *
 * Это единственное место во всём фронтенде, которое знает про HTTP. Заменить
 * фронтенд — значит выбросить приложение, а не этот файл; заменить транспорт —
 * значит переписать этот файл, не трогая приложения.
 */

export type AuthMode =
  | { kind: 'cookie'; csrfToken: string | null }
  | { kind: 'bearer'; getToken: () => string | null }
  | { kind: 'none' };

export interface ClientOptions {
  baseUrl: string;
  auth?: AuthMode;
  /** Таймаут по умолчанию. Запрос без таймаута — зависший интерфейс. */
  timeoutMs?: number;
  /** Хук для телеметрии и обработки 401 на уровне приложения. */
  onResponse?: (info: { url: string; status: number; durationMs: number }) => void;
  fetchImpl?: typeof fetch;
}

/** Ошибка API. Несёт машинный код, а не только текст. */
export class ApiError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly problem: ProblemDetails | null;
  readonly traceId: string | null;
  /** Через сколько секунд сервер разрешает повтор (429 / 503 с `Retry-After`). */
  readonly retryAfterSeconds: number | null;

  constructor(
    message: string,
    opts: {
      code: ErrorCodeValue;
      status: number;
      problem?: ProblemDetails | null;
      cause?: unknown;
      retryAfterSeconds?: number | null;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'ApiError';
    this.code = opts.code;
    this.status = opts.status;
    this.problem = opts.problem ?? null;
    this.traceId = opts.problem?.traceId ?? null;
    this.retryAfterSeconds = opts.retryAfterSeconds ?? null;
  }

  /** Требуется повышение уровня аутентификации (step-up MFA). */
  get needsStepUp(): boolean {
    return this.code === ErrorCode.STEP_UP_REQUIRED;
  }

  /** Пользователь не принял актуальные версии обязательных документов. */
  get needsConsents(): boolean {
    return this.code === ErrorCode.CONSENTS_REQUIRED || this.code === ErrorCode.REACCEPT_REQUIRED;
  }

  get needsSubscription(): boolean {
    return this.code === ErrorCode.SUBSCRIPTION_REQUIRED;
  }
}

export interface RequestOptions<TResponse> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Схема ответа. Ответ, не прошедший её, — ошибка, а не «как-нибудь отрендерим». */
  schema?: z.ZodType<TResponse>;
  /** Обязателен для денежных и регулируемых мутаций. */
  idempotencyKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Запрос переживает закрытие страницы (`fetch keepalive`): для последнего
   * автосохранения при уходе со страницы, чтобы набранное не пропало.
   */
  keepalive?: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
/** Повтор допустим только для безопасных методов: POST мог частично примениться. */
const RETRYABLE_METHODS = new Set(['GET']);
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_RETRIES = 2;

export class ApiClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #onResponse: ClientOptions['onResponse'];
  #auth: AuthMode;
  /**
   * Контекст доступа вкладки (M129): запрос выполняется от лица участника
   * тестовой сессии или просматриваемого пользователя.
   *
   * Живёт в КЛИЕНТЕ, а не в cookie, — в этом весь смысл. Cookie общая на
   * origin: переключение в одной вкладке меняло бы личность во всех, включая
   * админскую. Заголовок ставит та вкладка, которая о контексте знает.
   */
  #contextId: string | null = null;

  constructor(options: ClientOptions) {
    // Нормализация: без неё '//v1//pricing' проскакивает в продакшен.
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#auth = options.auth ?? { kind: 'none' };
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#onResponse = options.onResponse;
  }

  setAuth(auth: AuthMode): void {
    this.#auth = auth;
  }

  /** Контекст доступа вкладки. `null` — обычная работа от своего имени. */
  setAccessContext(contextId: string | null): void {
    this.#contextId = contextId;
  }

  get accessContext(): string | null {
    return this.#contextId;
  }

  /**
   * Адрес файла, который обязан читаться в текущем контексте.
   *
   * Зачем метод, а не строка в `src`. Картинку и файл браузер запрашивает
   * САМ, и заголовка контекста в таком запросе нет — значит он выполнится от
   * имени администратора, и во вкладке участника окажется то, что видно
   * администратору. Поэтому в контексте файл забирается обычным запросом с
   * заголовком, а в разметку идёт ссылка на полученные байты.
   *
   * Вне контекста возвращается обычный адрес: заводить лишние запросы там,
   * где личность и так верна, незачем.
   */
  async resolveFileUrl(path: string): Promise<string> {
    const url = this.#buildUrl(path);
    if (!this.#contextId) return url;
    const headers = new Headers({ 'X-Unicorn-Context': this.#contextId });
    const response = await this.#fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`файл недоступен: HTTP ${response.status}`);
    return URL.createObjectURL(await response.blob());
  }

  /** Обновление CSRF-токена после логина или ротации сессии. */
  setCsrfToken(token: string | null): void {
    if (this.#auth.kind === 'cookie') this.#auth = { kind: 'cookie', csrfToken: token };
  }

  async request<TResponse = unknown>(options: RequestOptions<TResponse>): Promise<TResponse> {
    const method = options.method ?? 'GET';
    const url = this.#buildUrl(options.path, options.query);

    let attempt = 0;
    for (;;) {
      const started = Date.now();
      try {
        const response = await this.#send(url, method, options);
        this.#onResponse?.({ url, status: response.status, durationMs: Date.now() - started });

        if (response.ok) return await this.#parseSuccess(response, options.schema);

        if (
          RETRYABLE_METHODS.has(method) &&
          RETRYABLE_STATUS.has(response.status) &&
          attempt < MAX_RETRIES &&
          // Выключенная функция — не временный сбой, а решение оператора:
          // повторять запрос к ней бессмысленно. Раньше открытие раздела с
          // выключенным контуром давало шесть одинаковых 503 подряд и лишнюю
          // секунду ожидания на пустом месте.
          !(await isFeatureDisabled(response))
        ) {
          attempt += 1;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw await this.#toApiError(response);
      } catch (error) {
        if (error instanceof ApiError) throw error;

        const isAbort = error instanceof Error && error.name === 'AbortError';
        if (!isAbort && RETRYABLE_METHODS.has(method) && attempt < MAX_RETRIES) {
          attempt += 1;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new ApiError(
          isAbort ? 'Превышено время ожидания ответа сервера' : 'Сеть недоступна',
          {
            // Код один и тот же намеренно: и таймаут, и обрыв сети для
            // вызывающего означают «зависимость недоступна». Раньше здесь
            // стоял тернарник с одинаковыми ветками — он выглядел как
            // различение, которого нет (INFO аудита №2). Различие видно в
            // ТЕКСТЕ ошибки выше.
            code: ErrorCode.DEPENDENCY_UNAVAILABLE,
            status: 0,
            cause: error,
          },
        );
      }
    }
  }

  #buildUrl(path: string, query?: RequestOptions<unknown>['query']): string {
    // Относительный базовый адрес (`/v1`) разрешается от адреса страницы.
    //
    // Это нужно для раздачи через обратный прокси: там фронтенд и API живут на
    // одном origin, и зашивать в сборку абсолютный адрес означало бы пересборку
    // под каждый домен — а заодно риск увести запросы на чужой хост. В Node
    // (скрипты, прогоны) `location` нет, и относительный адрес остаётся
    // ошибкой: там базовый адрес всегда известен явно.
    //
    // ПУСТАЯ строка — тоже относительный адрес, и обрабатывается так же.
    // Раньше она проваливалась мимо этой ветки и уходила в `new URL('/v1/…')`
    // без базы — конструктор бросал TypeError ДО единого сетевого запроса.
    // Административный кабинет задаёт базой именно пустую строку (пути в нём
    // уже содержат `/v1/`), и за единой точкой входа вход в него не работал
    // вовсе: браузер показывал «не удалось войти», хотя сервер об этой попытке
    // не знал. Найдено рендер-прогоном, а не чтением кода.
    const base =
      this.#baseUrl === '' || this.#baseUrl.startsWith('/')
        ? `${globalThis.location?.origin ?? ''}${this.#baseUrl}`
        : this.#baseUrl;
    const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #send(url: string, method: string, options: RequestOptions<unknown>): Promise<Response> {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);

    // Контекст ставится ДО выбора способа аутентификации и независимо от
    // него: он не заменяет вход, а уточняет, от чьего лица выполнить запрос.
    if (this.#contextId) headers.set('X-Unicorn-Context', this.#contextId);

    let credentials: RequestCredentials = 'omit';
    if (this.#auth.kind === 'cookie') {
      // Сессия — в httpOnly-cookie, поэтому её нужно отправлять; для
      // небезопасных методов добавляется double-submit CSRF-токен.
      credentials = 'include';
      if (method !== 'GET' && this.#auth.csrfToken) {
        headers.set('X-CSRF-Token', this.#auth.csrfToken);
      }
    } else if (this.#auth.kind === 'bearer') {
      const token = this.#auth.getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    // Таймаут обязателен на каждом внешнем вызове (RULES.md §3.1).
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

    return this.#fetch(url, {
      method,
      headers,
      credentials,
      signal,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      // Ответы API не кешируются промежуточными узлами: в них персональные данные.
      cache: 'no-store',
      redirect: 'error',
      keepalive: options.keepalive ?? false,
    });
  }

  async #parseSuccess<T>(response: Response, schema?: z.ZodType<T>): Promise<T> {
    if (response.status === 204) return undefined as T;
    const raw: unknown = await response.json();
    if (!schema) return raw as T;

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      // Ответ не соответствует контракту. Это дефект сервера или рассинхрон
      // версий — молча отдавать такое в UI нельзя.
      throw new ApiError('Ответ сервера не соответствует контракту API', {
        code: ErrorCode.INTERNAL_ERROR,
        status: response.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  async #toApiError(response: Response): Promise<ApiError> {
    let problem: ProblemDetails | null = null;
    try {
      const raw: unknown = await response.json();
      const parsed = ProblemDetailsSchema.safeParse(raw);
      if (parsed.success) problem = parsed.data;
    } catch {
      // Тело не JSON — работаем по статусу.
    }

    const code = problem?.code ?? statusToCode(response.status);
    const message = problem?.detail ?? problem?.title ?? defaultMessage(code);
    return new ApiError(message, {
      code,
      status: response.status,
      problem,
      retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
    });
  }
}

/** `Retry-After` бывает числом секунд или датой; всё остальное — «неизвестно». */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

function statusToCode(status: number): ErrorCodeValue {
  switch (status) {
    case 400:
      return ErrorCode.VALIDATION_FAILED;
    case 401:
      return ErrorCode.UNAUTHENTICATED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 503:
      return ErrorCode.DEPENDENCY_UNAVAILABLE;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

/** Сообщения по умолчанию: без внутренних деталей, но и без «что-то пошло не так». */
function defaultMessage(code: ErrorCodeValue): string {
  const messages: Partial<Record<ErrorCodeValue, string>> = {
    [ErrorCode.UNAUTHENTICATED]: 'Требуется вход',
    [ErrorCode.FORBIDDEN]: 'Недостаточно прав',
    [ErrorCode.STEP_UP_REQUIRED]: 'Требуется подтверждение вторым фактором',
    [ErrorCode.CONSENTS_REQUIRED]: 'Нужно принять условия платформы',
    [ErrorCode.REACCEPT_REQUIRED]: 'Условия обновились — требуется повторное принятие',
    [ErrorCode.SUBSCRIPTION_REQUIRED]: 'Нужна активная подписка',
    [ErrorCode.KYC_REQUIRED]: 'Требуется пройти верификацию',
    [ErrorCode.NOT_FOUND]: 'Не найдено',
    [ErrorCode.CONFLICT]: 'Конфликт состояния — обновите данные и повторите',
    [ErrorCode.RATE_LIMITED]: 'Слишком много запросов, повторите позже',
    [ErrorCode.FEATURE_DISABLED]: 'Функция пока недоступна',
    [ErrorCode.DEPENDENCY_UNAVAILABLE]: 'Сервис временно недоступен',
  };
  return messages[code] ?? 'Не удалось выполнить операцию';
}

/**
 * Ответ «функция выключена»?
 *
 * Тело читается с КЛОНА: оригинал ещё понадобится для разбора ошибки, а поток
 * тела можно прочитать только один раз. Любая осечка разбора означает «не
 * знаем» — тогда повтор разрешён, как и раньше.
 */
async function isFeatureDisabled(response: Response): Promise<boolean> {
  if (response.status !== 503) return false;
  try {
    const problem = (await response.clone().json()) as { code?: unknown };
    return problem?.code === 'feature_disabled';
  } catch {
    return false;
  }
}

function backoffMs(attempt: number): number {
  // Экспонента с джиттером: без джиттера повторы клиентов синхронизируются
  // и превращаются в собственную DDoS-атаку на восстанавливающийся сервис.
  //
  // Источник случайности — CSPRNG, хотя криптостойкость здесь и не требуется:
  // в этой кодовой базе Math.random() запрещён без исключений, чтобы правило
  // не приходилось каждый раз обсуждать заново и чтобы не осталось места, где
  // «здесь было можно» тихо переехало в генерацию токена.
  const base = 200 * 2 ** (attempt - 1);
  const random = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32;
  return base + Math.floor(random * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
