import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ErrorCode, problemTypeUri, type ProblemDetails } from '@unicorn/contracts';
import { AppError } from './errors';

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
    const traceId = (request.headers['x-request-id'] as string | undefined) ?? request.id;

    const { problem, internal, cause } = this.toProblem(exception, request.url, traceId);

    if (problem.status >= 500) {
      this.logger.error({
        msg: 'необработанная ошибка',
        traceId,
        code: problem.code,
        path: request.url,
        method: request.method,
        internal,
        error: cause instanceof Error ? { message: cause.message, stack: cause.stack } : cause,
      });
    } else {
      this.logger.warn({
        msg: 'ошибка запроса',
        traceId,
        code: problem.code,
        status: problem.status,
        path: request.url,
        method: request.method,
        internal,
      });
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
  ): { problem: ProblemDetails; internal?: Record<string, unknown>; cause?: unknown } {
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
  [ErrorCode.SUBSCRIPTION_REQUIRED]: 'Требуется подписка',
  [ErrorCode.KYC_REQUIRED]: 'Требуется верификация',
  [ErrorCode.NOT_FOUND]: 'Не найдено',
  [ErrorCode.CONFLICT]: 'Конфликт состояния',
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 'Повторное использование ключа',
  [ErrorCode.LIMIT_EXCEEDED]: 'Превышен лимит',
  [ErrorCode.SELF_DEAL_FORBIDDEN]: 'Сделка с самим собой запрещена',
  [ErrorCode.PLAN_UPGRADE_REQUIRED]: 'Требуется смена тарифа',
  [ErrorCode.RATE_LIMITED]: 'Слишком много запросов',
  [ErrorCode.FEATURE_DISABLED]: 'Функция недоступна',
  [ErrorCode.INTERNAL_ERROR]: 'Внутренняя ошибка',
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 'Сервис временно недоступен',
};
