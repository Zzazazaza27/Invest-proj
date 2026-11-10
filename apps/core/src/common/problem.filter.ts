import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, problemTypeUri, type ProblemDetails } from '@fifth/contracts';
import { AppError } from './errors';
import { safeError } from './logging/safe-log';

/** Код результата запроса для журнала запросов (8.4): ставит фильтр. */
const PROBLEM_CODE = Symbol('problemCode');

export function problemCodeOf(request: FastifyRequest): string | undefined {
  return (request as FastifyRequest & { [PROBLEM_CODE]?: string })[PROBLEM_CODE];
}

/**
 * Единая точка формирования ответа об ошибке (RFC 9457).
 *
 * Гарантирует три вещи:
 *  1. Наружу не уходит ничего, кроме явно разрешённого: ни стека, ни текста
 *     ошибки драйвера БД, ни имён таблиц.
 *  2. Каждая ошибка имеет машинный код — фронтенд ветвится по нему, а не по
 *     тексту сообщения.
 *  3. Каждый ответ несёт traceId, по которому инцидент находится в логе.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest>();
    // Не сырой заголовок: `request.id` — это тот же внешний идентификатор, но
    // уже прошедший проверку формата (см. acceptableRequestId в main.ts).
    // Чтение заголовка напрямую обходило её и возвращало управляющие символы в
    // журнал (SEC-15).
    const traceId = request.id;

    const { problem, internal, cause, retryAfter } = this.toProblem(
      exception,
      request.url,
      traceId,
      request.method,
    );
    (request as FastifyRequest & { [PROBLEM_CODE]?: string })[PROBLEM_CODE] = problem.code;

    // В журнал — шаблон маршрута, а не адрес (в адресе query и
    // идентификаторы), и исключение без текста (8.4): класс, код драйвера,
    // кадры стека. Наружу по-прежнему уходит только problem.
    const route = request.routeOptions?.url ?? '(нет маршрута)';
    if (problem.status >= 500) {
      this.logger.error({
        msg: 'необработанная ошибка',
        traceId,
        code: problem.code,
        route,
        method: request.method,
        internal,
        ...(cause === undefined ? {} : safeError(cause)),
      });
    } else {
      this.logger.warn({
        msg: 'ошибка запроса',
        traceId,
        code: problem.code,
        status: problem.status,
        route,
        method: request.method,
        internal,
      });
    }

    if (retryAfter && !reply.hasHeader('retry-after')) {
      void reply.header('Retry-After', String(DEPENDENCY_RETRY_AFTER_SEC));
    }
    void reply
      .status(problem.status)
      .header('Content-Type', 'application/problem+json; charset=utf-8')
      .send(problem);
  }

  private toProblem(
    exception: unknown,
    instance: string,
    traceId: string,
    method: string,
  ): {
    problem: ProblemDetails;
    internal?: Record<string, unknown>;
    cause?: unknown;
    retryAfter?: boolean;
  } {
    if (exception instanceof AppError) {
      return {
        problem: {
          type: exception.typeUri,
          title: TITLES[exception.code] ?? 'Ошибка',
          status: exception.status,
          code: exception.code,
          ...(exception.publicDetail ? { detail: exception.publicDetail } : {}),
          ...(exception.fieldErrors ? { errors: exception.fieldErrors } : {}),
          instance,
          traceId,
        },
        internal: exception.internal,
        cause: exception.cause,
      };
    }

    // @fastify/rate-limit бросает готовый payload, а не HttpException. Без
    // этой ветки ограничение частоты возвращало бы 500 вместо 429 — то есть
    // защита работала бы, но выглядела как поломка сервера.
    if (isProblemShaped(exception)) {
      return { problem: { ...exception, instance, traceId } };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = status === 404 ? ErrorCode.NOT_FOUND : mapStatus(status);
      return {
        problem: {
          type: problemTypeUri(code),
          title: TITLES[code] ?? 'Ошибка',
          status,
          code,
          instance,
          traceId,
        },
        cause: exception,
      };
    }

    // Связь с зависимостью (база, кэш) недоступна: это 503, а не ошибка кода. До 10.11 такие
    // отказы уходили как 500 — клиент не отличал их от дефекта (W32: PostgreSQL остановлен
    // на 60 с — все ответы 500). Ошибки SQL, схемы и прав сюда не попадают.
    // Повтор разрешается (Retry-After) только когда операция точно не выполнялась: соединения
    // не было, или запрос не изменяющий. Обрыв посреди изменяющего запроса — исход
    // неизвестен (фиксация могла пройти): без Retry-After, слепой повтор не предлагается;
    // защищённые операции повторяются только с прежним ключом повтора.
    //
    // СТАТУС 504 для неизвестного исхода — ПЕРЕХОДНОЕ решение (согласовано Тэнком 10.11,
    // docs/architecture/w32-unknown-outcome-transition.md). Причина — совместимость, а не
    // смысл 504 по стандарту: клиенты, уже выпущенные в открытые вкладки, поля `outcome` не
    // знают, но с 2.6 удерживают операцию и ключ на 502/504 изменяющего запроса. Признак для
    // новых клиентов — `outcome: unknown`. Подтверждённый отказ — 503 с `not_started`.
    // Возврат к 503 — по условию из того же документа.
    const down = connectionFailure(exception);
    if (down) {
      const unknownOutcome = down.kind === 'broken' && !SAFE_METHODS.has(method);
      return {
        problem: {
          type: problemTypeUri(ErrorCode.DEPENDENCY_UNAVAILABLE),
          title: TITLES[ErrorCode.DEPENDENCY_UNAVAILABLE] ?? 'Сервис временно недоступен',
          status: unknownOutcome ? UNKNOWN_OUTCOME_STATUS : 503,
          code: ErrorCode.DEPENDENCY_UNAVAILABLE,
          detail: unknownOutcome
            ? 'Связь прервалась во время операции, её результат неизвестен. Проверьте результат, прежде чем повторять'
            : 'Сервис временно недоступен, попробуйте позже',
          instance,
          traceId,
          // Машинный признак исхода (контракт ProblemDetails.outcome): клиент опирается на
          // него, а не на текст и не на отсутствие Retry-After. Чтение после обрыва ничего
          // не меняло — поле не ставится.
          ...(unknownOutcome
            ? { outcome: 'unknown' as const }
            : down.kind === 'refused'
              ? { outcome: 'not_started' as const }
              : {}),
        },
        internal: { connection: down.label, kind: down.kind, unknownOutcome },
        cause: exception,
        retryAfter: !unknownOutcome,
      };
    }

    // Неизвестное исключение: наружу — только общее сообщение. Всё остальное
    // (включая возможные значения полей) остаётся в логе.
    return {
      problem: {
        type: problemTypeUri(ErrorCode.INTERNAL_ERROR),
        title: 'Внутренняя ошибка',
        status: 500,
        code: ErrorCode.INTERNAL_ERROR,
        detail: 'Внутренняя ошибка. Обратитесь в поддержку с идентификатором запроса',
        instance,
        traceId,
      },
      cause: exception,
    };
  }
}

/** Через сколько секунд повторить при недоступной зависимости: короткий отказ БД — секунды. */
export const DEPENDENCY_RETRY_AFTER_SEC = 5;

/**
 * Статус неизвестного исхода изменения: 504 — переходный, ради клиентов в открытых вкладках
 * (см. комментарий в toProblem и docs/architecture/w32-unknown-outcome-transition.md).
 */
export const UNKNOWN_OUTCOME_STATUS = 504;

/** Методы без изменений: повтор после обрыва безопасен. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Соединения не было — запрос до базы не дошёл: отказ в подключении, адрес недоступен,
 * тайм-аут пула при подключении, 57P03 (сервер ещё не принимает), 08001/08004 (клиент не
 * смог / сервер отклонил установку соединения).
 */
const REFUSED_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
const REFUSED_SQLSTATE = /^(57P03|08001|08004)$/;
const REFUSED_TEXT = /timeout exceeded when trying to connect/i;
/** Соединение было и оборвалось: исход операции, что успела дойти, неизвестен. */
const BROKEN_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EPIPE']);
const BROKEN_SQLSTATE = /^(57P01|57P02|08[0-9A-Z]{3})$/;
const BROKEN_TEXT =
  /Connection terminated|Client has encountered a connection error|Connection ended unexpectedly/i;

export interface ConnectionFailure {
  /** refused — соединения не было; broken — оборвалось во время работы. */
  kind: 'refused' | 'broken';
  label: string;
}

/**
 * Отказ СВЯЗИ с зависимостью, а не ошибка запроса. Ищется по цепочке `cause` (обёртки
 * драйвера и пула). Ошибки SQL, схемы и прав (23505, 42501, 42P01 и т. п.) сюда не
 * попадают — они остаются 4xx/500. null — не отказ связи.
 */
export function connectionFailure(exception: unknown): ConnectionFailure | null {
  let current: unknown = exception;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const e = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof e.code === 'string' ? e.code : '';
    const message = typeof e.message === 'string' ? e.message : '';
    if (REFUSED_CODES.has(code)) return { kind: 'refused', label: code };
    if (REFUSED_SQLSTATE.test(code)) return { kind: 'refused', label: `sqlstate ${code}` };
    if (REFUSED_TEXT.test(message)) return { kind: 'refused', label: 'pg pool connect timeout' };
    if (BROKEN_CODES.has(code)) return { kind: 'broken', label: code };
    if (BROKEN_SQLSTATE.test(code)) return { kind: 'broken', label: `sqlstate ${code}` };
    if (BROKEN_TEXT.test(message)) return { kind: 'broken', label: 'pg connection lost' };
    current = e.cause;
  }
  return null;
}

/** Похоже ли исключение на готовый problem+json (payload плагина). */
function isProblemShaped(value: unknown): value is ProblemDetails {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.status === 'number' &&
    typeof candidate.code === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.type === 'string'
  );
}

function mapStatus(status: number): (typeof ErrorCode)[keyof typeof ErrorCode] {
  if (status === 401) return ErrorCode.UNAUTHENTICATED;
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 409) return ErrorCode.CONFLICT;
  if (status === 413) return ErrorCode.PAYLOAD_TOO_LARGE;
  if (status === 429) return ErrorCode.RATE_LIMITED;
  if (status >= 400 && status < 500) return ErrorCode.VALIDATION_FAILED;
  return ErrorCode.INTERNAL_ERROR;
}

const TITLES: Partial<Record<string, string>> = {
  [ErrorCode.VALIDATION_FAILED]: 'Некорректные данные',
  [ErrorCode.UNAUTHENTICATED]: 'Требуется вход',
  [ErrorCode.FORBIDDEN]: 'Доступ запрещён',
  [ErrorCode.STEP_UP_REQUIRED]: 'Нужен второй фактор',
  [ErrorCode.CONSENTS_REQUIRED]: 'Требуется принять условия',
  [ErrorCode.REACCEPT_REQUIRED]: 'Условия обновились',
  [ErrorCode.KYC_REQUIRED]: 'Требуется верификация',
  [ErrorCode.NOT_FOUND]: 'Не найдено',
  [ErrorCode.CONFLICT]: 'Конфликт состояния',
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 'Повторное использование ключа',
  [ErrorCode.OPERATION_IN_PROGRESS]: 'Операция выполняется',
  [ErrorCode.IDEMPOTENCY_KEY_EXPIRED]: 'Срок повтора истёк',
  [ErrorCode.LIMIT_EXCEEDED]: 'Превышен лимит',
  [ErrorCode.RATE_LIMITED]: 'Слишком много запросов',
  [ErrorCode.FEATURE_DISABLED]: 'Функция недоступна',
  [ErrorCode.GROUP_UNAVAILABLE]: 'Группа функций недоступна',
  [ErrorCode.INTERNAL_ERROR]: 'Внутренняя ошибка',
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 'Сервис временно недоступен',
};
