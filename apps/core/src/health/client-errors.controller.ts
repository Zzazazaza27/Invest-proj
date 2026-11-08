import { Body, Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import {
  CLIENT_ERROR_LIMITS,
  ErrorCode,
  parseClientErrorReport,
  type ClientErrorReport,
} from '@fifth/contracts';
import { CsrfOriginFallback, Public } from '../auth/guards';
import { getCounters, type Counters } from '../cache/counters';
import { AppError } from '../common/errors';
import { getEnv } from '../config/env';

/** Окно ограничения частоты, мс. */
const WINDOW_MS = 60_000;
/** Сообщений за окно с одного адреса. */
export const PER_ADDRESS_LIMIT = 30;
/** Сообщений за окно всего (с Valkey — на платформу, без него — на экземпляр). */
export const TOTAL_LIMIT = 600;
/** Предел числа адресов в памяти экземпляра (запасной режим без Valkey). */
export const MAX_LOCAL_ADDRESSES = 10_000;

/**
 * Приём ошибок интерфейса (блок 8, 8.4).
 *
 * Сообщение — техническая диагностика из закрытого перечня полей и значений
 * (`parseClientErrorReport`); запись — в технический журнал через общий безопасный
 * механизм, без таблиц. В записи пометка `reported: browser`: значения сообщил браузер,
 * сервер их не проверял по существу. Origin отсекает посторонние сайты, но достоверности
 * сообщения не доказывает.
 *
 * Ответы: принято и отброшено по лимиту — 202 (одинаково: отправитель не узнаёт о
 * лимите и всё равно не повторяет). Чужой Origin — 403, неверный формат — 400, размер —
 * 413; в отказе нет ни имён, ни значений полей.
 *
 * Ограничение частоты — свой счётчик этого НЕОБЯЗАТЕЛЬНОГО приёмника. При отказе Valkey
 * действует локальный предел экземпляра: только здесь — обязательные ограничения других
 * API не ослабляются (у них своя политика).
 */
@Controller('client-errors')
export class ClientErrorsController {
  private readonly logger = new Logger('client-errors');
  private readonly limiter = new ClientErrorLimiter(getCounters());

  @Public()
  // Сообщение может прийти из вкладки с устаревшей CSRF-парой (после выхода, на странице
  // входа): достаточно доказанного браузером same-origin. Состояние не меняется.
  @CsrfOriginFallback()
  @Post()
  @HttpCode(202)
  async receive(@Req() request: FastifyRequest, @Body() body: unknown): Promise<void> {
    if (!originAllowed(request.headers.origin)) {
      throw new AppError(ErrorCode.FORBIDDEN, {
        publicDetail: 'Источник не принят',
        internal: { stage: 'client-error-origin' },
      });
    }
    const length = Number(request.headers['content-length'] ?? NaN);
    const size = Number.isFinite(length) ? length : Buffer.byteLength(JSON.stringify(body ?? null));
    if (size > CLIENT_ERROR_LIMITS.maxBodyBytes) {
      throw new AppError(ErrorCode.PAYLOAD_TOO_LARGE, {
        publicDetail: 'Сообщение слишком большое',
        internal: { stage: 'client-error-size' },
      });
    }
    const parsed = parseClientErrorReport(body);
    if (!parsed.ok) {
      // Без fieldErrors: путь поля — это имя, а имя может нести чужие данные.
      throw new AppError(ErrorCode.VALIDATION_FAILED, {
        publicDetail: 'Сообщение не принято',
        internal: { stage: 'client-error-format' },
      });
    }

    const verdict = await this.limiter.admit(request.ip);
    if (verdict.notice) {
      this.logger.warn({
        msg: 'ограничение приёма ошибок интерфейса',
        reason: verdict.notice.reason,
        limit: verdict.notice.limit,
        flag: verdict.notice.scope,
      });
    }
    if (!verdict.admitted) return;
    this.logger.warn(clientErrorRecord(parsed.report, parsed.dropped));
  }
}

/** Запись журнала: только поля перечня, числа и значения из закрытых списков. */
export function clientErrorRecord(report: ClientErrorReport, dropped: number) {
  return {
    msg: 'ошибка интерфейса',
    reported: 'browser',
    cabinet: report.cabinet,
    screen: report.screen,
    appVersion: report.version,
    code: report.code,
    stage: report.stage,
    ...(report.requestId ? { requestId: report.requestId } : {}),
    ...(report.viewportWidth !== undefined ? { viewportWidth: report.viewportWidth } : {}),
    ...(report.viewportHeight !== undefined ? { viewportHeight: report.viewportHeight } : {}),
    count: report.count,
    droppedFields: dropped,
  };
}

function originAllowed(origin: unknown): boolean {
  if (typeof origin !== 'string') return false;
  const env = getEnv();
  // PUBLIC_BASE_URL уже проверен схемой конфигурации как URL.
  return origin === new URL(env.PUBLIC_BASE_URL).origin || env.corsOrigins.includes(origin);
}

interface Verdict {
  admitted: boolean;
  /** Первое превышение в окне — одна запись об ограничении, а не по записи на сообщение. */
  notice?: { reason: 'address' | 'total'; limit: number; scope: 'platform' | 'instance' };
}

/**
 * Счётчик частоты приёмника. С Valkey — общий для платформы; Valkey не настроен или не
 * ответил — локальное окно экземпляра (предел действует на экземпляр, не на платформу).
 */
export class ClientErrorLimiter {
  /** Счётчики адресов экземпляра; при переполнении очищаются только они. */
  private local = new Map<string, { used: number; until: number }>();
  /** Общий счётчик экземпляра — отдельно: очистка адресов его не трогает. */
  private localTotal = { used: 0, until: 0 };

  constructor(
    private readonly counters: Counters | null,
    private readonly now: () => number = Date.now,
  ) {}

  async admit(address: string): Promise<Verdict> {
    const bucket = Math.floor(this.now() / WINDOW_MS);
    let scope: 'platform' | 'instance' = 'platform';
    let perAddress: number;
    let total: number;
    try {
      if (!this.counters) throw new Error('no counters');
      perAddress = (await this.counters.hit(`ce:a:${address}:${bucket}`, WINDOW_MS)).used;
      total = (await this.counters.hit(`ce:t:${bucket}`, WINDOW_MS)).used;
    } catch {
      scope = 'instance';
      perAddress = this.localHit(address);
      total = this.localTotalHit();
    }
    if (perAddress > PER_ADDRESS_LIMIT) {
      return {
        admitted: false,
        ...(perAddress === PER_ADDRESS_LIMIT + 1
          ? { notice: { reason: 'address' as const, limit: PER_ADDRESS_LIMIT, scope } }
          : {}),
      };
    }
    if (total > TOTAL_LIMIT) {
      return {
        admitted: false,
        ...(total === TOTAL_LIMIT + 1
          ? { notice: { reason: 'total' as const, limit: TOTAL_LIMIT, scope } }
          : {}),
      };
    }
    return { admitted: true };
  }

  private localHit(key: string): number {
    const now = this.now();
    const entry = this.local.get(key);
    if (!entry || entry.until <= now) {
      // Предел памяти: при переполнении убираются адреса. Общий счётчик живёт отдельно,
      // поэтому очистка не открывает нового бюджета в текущем окне — его держит
      // `localTotal`. Сброшенный адрес теряет только свой счёт.
      if (this.local.size >= MAX_LOCAL_ADDRESSES) this.local.clear();
      this.local.set(key, { used: 1, until: now + WINDOW_MS });
      return 1;
    }
    entry.used += 1;
    return entry.used;
  }

  private localTotalHit(): number {
    const now = this.now();
    if (this.localTotal.until <= now) this.localTotal = { used: 0, until: now + WINDOW_MS };
    this.localTotal.used += 1;
    return this.localTotal.used;
  }
}
