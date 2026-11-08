import { Component, type ReactNode } from 'react';
import {
  CLIENT_ERROR_LIMITS,
  clientErrorScreen,
  type ClientErrorCabinet,
  type ClientErrorCode,
  type ClientErrorReport,
  type ClientErrorStage,
} from '@fifth/contracts';

/**
 * Отправка ошибок интерфейса (блок 8, 8.4).
 *
 * Только поля перечня: кабинет, экран (шаблон маршрута), версия, постоянный код, этап,
 * ID запроса, размер окна, число повторов. Текста ошибки, стека, адреса, полей формы и
 * пользователя нет — их здесь даже не читают.
 *
 * Сведение повторов: первая ошибка с данным кодом, этапом и экраном уходит сразу
 * (count = 1); следующие такие же копятся и уходят одним сообщением с их числом — через
 * FLUSH_MS после первого повтора или при уходе со страницы (`pagehide`, keepalive). Не
 * больше `maxReportsPerPage` сообщений с загрузки страницы; сверх — не отправляются.
 *
 * Ограничение: повторы, накопленные к закрытию вкладки, теряются, если браузер не
 * выполнил `pagehide` или не доставил keepalive-запрос. Одна попытка, без очереди и
 * повторов: недоступный приёмник — диагностика просто не доходит.
 */
export const FLUSH_MS = 10_000;

interface ReporterOptions {
  cabinet: ClientErrorCabinet;
  version: string;
  /** Адрес API вместе с `/v1`. */
  apiBaseUrl: string;
  /** Базовый путь кабинета (`import.meta.env.BASE_URL`), отрезается перед поиском экрана. */
  basePath: string;
  fetchImpl?: typeof fetch;
  win?: Window;
}

interface Pending {
  code: ClientErrorCode;
  stage: ClientErrorStage;
  screen: string;
  count: number;
}

export interface ClientErrorReporter {
  report(code: ClientErrorCode, stage: ClientErrorStage, requestId?: string | null): void;
  /** Отправить накопленные повторы сейчас. */
  flush(keepalive?: boolean): void;
  /** Сколько сообщений уже отправлено с этой загрузки. */
  sent(): number;
  dispose(): void;
}

let active: ClientErrorReporter | null = null;

/** Сообщить об ошибке через установленный отправитель; нет его — ничего не делает. */
export function reportClientError(
  code: ClientErrorCode,
  stage: ClientErrorStage,
  requestId?: string | null,
): void {
  active?.report(code, stage, requestId);
}

/** Клиентский отказ API → сообщение (хук `onFailure` клиента API). */
export function reportApiFailure(info: { status: number; requestId: string | null }): void {
  const unavailable =
    info.status === 0 || info.status === 502 || info.status === 503 || info.status === 504;
  reportClientError(
    unavailable ? 'api.unavailable' : 'api.server_error',
    'request',
    info.requestId,
  );
}

export function createClientErrorReporter(options: ReporterOptions): ClientErrorReporter {
  const win = options.win ?? window;
  const doFetch = options.fetchImpl ?? win.fetch.bind(win);
  const seen = new Set<string>();
  const pending = new Map<string, Pending>();
  let sentCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const screen = () => {
    const base = options.basePath.replace(/\/+$/, '');
    let path = win.location.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
    return clientErrorScreen(options.cabinet, path);
  };

  const send = (body: ClientErrorReport, keepalive: boolean) => {
    if (sentCount >= CLIENT_ERROR_LIMITS.maxReportsPerPage) return;
    sentCount += 1;
    try {
      void doFetch(`${options.apiBaseUrl}/client-errors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        keepalive,
        body: JSON.stringify(body),
      }).catch(() => undefined);
    } catch {
      // Отправка диагностики не порождает новой диагностики.
    }
  };

  const base = (p: { code: ClientErrorCode; stage: ClientErrorStage; screen: string }) => {
    const body: ClientErrorReport = {
      cabinet: options.cabinet,
      screen: p.screen,
      version: options.version,
      code: p.code,
      stage: p.stage,
      count: 1,
    };
    const w = Math.round(win.innerWidth);
    const h = Math.round(win.innerHeight);
    if (Number.isFinite(w) && w >= 0 && w <= CLIENT_ERROR_LIMITS.maxViewport)
      body.viewportWidth = w;
    if (Number.isFinite(h) && h >= 0 && h <= CLIENT_ERROR_LIMITS.maxViewport)
      body.viewportHeight = h;
    return body;
  };

  const flush = (keepalive = false) => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    for (const [key, p] of pending) {
      pending.delete(key);
      send({ ...base(p), count: Math.min(p.count, CLIENT_ERROR_LIMITS.maxCount) }, keepalive);
    }
  };

  const reporter: ClientErrorReporter = {
    report(code, stage, requestId) {
      const s = screen();
      const key = `${code}|${stage}|${s}`;
      if (!seen.has(key)) {
        seen.add(key);
        const body = base({ code, stage, screen: s });
        if (requestId && /^[0-9a-f-]{36}$/.test(requestId)) body.requestId = requestId;
        send(body, false);
        return;
      }
      const p = pending.get(key);
      if (p) p.count += 1;
      else pending.set(key, { code, stage, screen: s, count: 1 });
      if (!timer) timer = setTimeout(() => flush(false), FLUSH_MS);
    },
    flush,
    sent: () => sentCount,
    dispose() {
      win.removeEventListener('error', onError);
      win.removeEventListener('unhandledrejection', onRejection);
      win.removeEventListener('vite:preloadError', onPreload);
      win.removeEventListener('pagehide', onHide);
      if (timer) clearTimeout(timer);
      if (active === reporter) active = null;
    },
  };

  function onError(event: Event) {
    // Ошибка загрузки ресурса (`<script>`, `<img>`) приходит без `error` — это не
    // исключение кода; загрузку частей ловит `vite:preloadError`.
    if (!('message' in event)) return;
    const errorEvent = event as ErrorEvent;
    const chunk = isChunkError(errorEvent.error);
    reporter.report(chunk ? 'chunk.load_failed' : 'js.uncaught', chunk ? 'load' : 'unknown');
  }
  function onRejection(event: PromiseRejectionEvent) {
    const chunk = isChunkError(event.reason);
    reporter.report(chunk ? 'chunk.load_failed' : 'js.rejection', chunk ? 'load' : 'unknown');
  }
  function onPreload() {
    reporter.report('chunk.load_failed', 'load');
  }
  function onHide() {
    flush(true);
  }

  win.addEventListener('error', onError);
  win.addEventListener('unhandledrejection', onRejection);
  win.addEventListener('vite:preloadError', onPreload);
  win.addEventListener('pagehide', onHide);
  active = reporter;
  return reporter;
}

/** Не загрузилась часть приложения — признак по классу и имени, текст не сохраняется. */
function isChunkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module|Importing a module script failed/.test(
      error.message,
    )
  );
}

/**
 * Граница ошибок отрисовки. При отказе показывает то же, что React без границы, — пустой
 * экран (поведение интерфейса не меняется), и сообщает `render.boundary`.
 */
export class ClientErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch() {
    reportClientError('render.boundary', 'render');
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
