import { z } from 'zod';

/**
 * Ошибки API — RFC 9457 (`application/problem+json`).
 *
 * Принцип: наружу уходит generic-описание, детали остаются во внутренних логах
 * (RULES.md §3.1). `traceId` позволяет связать жалобу пользователя с логом, не
 * раскрывая ему устройство системы.
 */

/**
 * Коды ошибок — часть публичного контракта: фронтенд ветвится по ним, а не по
 * тексту сообщения. Тексты локализуются и меняются, коды — нет.
 */
export const ErrorCode = {
  // 400
  VALIDATION_FAILED: 'validation_failed',
  MALFORMED_BODY: 'malformed_body',
  UNKNOWN_FIELD: 'unknown_field',
  DUPLICATE_KEY: 'duplicate_key',
  PAYLOAD_TOO_LARGE: 'payload_too_large',

  // 401 / 403
  UNAUTHENTICATED: 'unauthenticated',
  TOKEN_EXPIRED: 'token_expired',
  INSUFFICIENT_SCOPE: 'insufficient_scope',
  STEP_UP_REQUIRED: 'step_up_required',
  FORBIDDEN: 'forbidden',
  CONSENTS_REQUIRED: 'consents_required',
  REACCEPT_REQUIRED: 'reaccept_required',
  KYC_REQUIRED: 'kyc_required',

  // 404 / 409 / 422
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  IDEMPOTENCY_KEY_REUSED: 'idempotency_key_reused',
  /** Операция с этим ключом ещё выполняется: второй работы нет, результат — позже (2.6). */
  OPERATION_IN_PROGRESS: 'operation_in_progress',
  /** Окно повтора ключа истекло: прежний результат не выдаётся, новая работа не начата. */
  IDEMPOTENCY_KEY_EXPIRED: 'idempotency_key_expired',
  STATE_TRANSITION_NOT_ALLOWED: 'state_transition_not_allowed',
  LIMIT_EXCEEDED: 'limit_exceeded',
  /**
   * Операция потребовала бы передачи ограниченных данных за пределы
   * разрешённых юрисдикций (152-ФЗ, ADR-007). Отдельный код нужен, чтобы
   * клиент НЕ повторял запрос: это не сбой, а запрет.
   */
  RESIDENCY_VIOLATION: 'residency_violation',

  // 429 / 5xx
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',
  DEPENDENCY_UNAVAILABLE: 'dependency_unavailable',
  FEATURE_DISABLED: 'feature_disabled',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeSchema = z.enum(
  Object.values(ErrorCode) as [ErrorCodeValue, ...ErrorCodeValue[]],
);

/** База URI для `type`. Документация по коду доступна человеку и машине. */
export const PROBLEM_TYPE_BASE = 'https://5espace.com/problems';

export const ProblemDetailsSchema = z.object({
  /** URI вида https://5espace.com/problems/<code> */
  type: z.url(),
  /** Короткий человекочитаемый заголовок, не зависящий от конкретного случая. */
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ErrorCodeSchema,
  /**
   * Пояснение для пользователя. НИКОГДА не содержит стек, SQL, имена таблиц,
   * внутренние адреса и чужие персональные данные.
   */
  detail: z.string().optional(),
  /** URI ресурса, к которому относится ошибка. */
  instance: z.string().optional(),
  /** Сквозной идентификатор для связи с внутренним логом. */
  traceId: z.string().optional(),
  /**
   * Ошибки валидации по полям. Присутствует только при VALIDATION_FAILED и
   * описывает поля запроса, а не внутреннюю модель.
   */
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export function problemTypeUri(code: ErrorCodeValue): string {
  return `${PROBLEM_TYPE_BASE}/${code}`;
}

/** Соответствие кода и HTTP-статуса — единое для сервера и клиента. */
export const ERROR_STATUS: Record<ErrorCodeValue, number> = {
  [ErrorCode.VALIDATION_FAILED]: 400,
  [ErrorCode.MALFORMED_BODY]: 400,
  [ErrorCode.UNKNOWN_FIELD]: 400,
  [ErrorCode.DUPLICATE_KEY]: 400,
  [ErrorCode.PAYLOAD_TOO_LARGE]: 413,
  [ErrorCode.UNAUTHENTICATED]: 401,
  [ErrorCode.TOKEN_EXPIRED]: 401,
  [ErrorCode.INSUFFICIENT_SCOPE]: 403,
  [ErrorCode.STEP_UP_REQUIRED]: 403,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.CONSENTS_REQUIRED]: 403,
  [ErrorCode.REACCEPT_REQUIRED]: 403,
  [ErrorCode.KYC_REQUIRED]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.OPERATION_IN_PROGRESS]: 409,
  [ErrorCode.IDEMPOTENCY_KEY_EXPIRED]: 409,
  [ErrorCode.STATE_TRANSITION_NOT_ALLOWED]: 409,
  [ErrorCode.LIMIT_EXCEEDED]: 422,
  [ErrorCode.RESIDENCY_VIOLATION]: 403,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: 503,
  [ErrorCode.FEATURE_DISABLED]: 503,
};
