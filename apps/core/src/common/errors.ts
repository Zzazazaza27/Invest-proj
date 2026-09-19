import { ERROR_STATUS, ErrorCode, problemTypeUri, type ErrorCodeValue } from '@unicorn/contracts';

/**
 * Доменная ошибка приложения.
 *
 * Наружу уходит только то, что здесь указано явно. Всё остальное — сообщение
 * драйвера БД, текст исключения, стек — остаётся во внутреннем логе
 * (RULES.md §3.1: «наружу — generic-ошибки»).
 */
export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly status: number;
  readonly publicDetail: string | undefined;
  readonly fieldErrors: { path: string; message: string }[] | undefined;
  /** Данные для внутреннего лога. Наружу НЕ попадают. */
  readonly internal: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCodeValue,
    options: {
      publicDetail?: string;
      internal?: Record<string, unknown>;
      fieldErrors?: { path: string; message: string }[];
      cause?: unknown;
    } = {},
  ) {
    super(options.publicDetail ?? code, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.publicDetail = options.publicDetail;
    this.fieldErrors = options.fieldErrors;
    this.internal = options.internal;
  }

  get typeUri(): string {
    return problemTypeUri(this.code);
  }
}

export const errors = {
  unauthenticated: (internal?: Record<string, unknown>) =>
    new AppError(ErrorCode.UNAUTHENTICATED, { publicDetail: 'Требуется вход', internal }),

  /**
   * Отказ по правам. По умолчанию наружу идёт общая формулировка: посторонний
   * не должен по тексту ошибки узнавать устройство доступа. Для действий
   * СОТРУДНИКА текст можно уточнить — ему нужно знать, какого именно
   * полномочия или назначения не хватает, иначе интерфейс непроходим.
   */
  forbidden: (internal?: Record<string, unknown>, publicDetail = 'Недостаточно прав') =>
    new AppError(ErrorCode.FORBIDDEN, { publicDetail, internal }),

  stepUpRequired: () =>
    new AppError(ErrorCode.STEP_UP_REQUIRED, {
      publicDetail: 'Операция требует подтверждения вторым фактором',
    }),

  consentsRequired: (missing: string[]) =>
    new AppError(ErrorCode.CONSENTS_REQUIRED, {
      publicDetail: 'Необходимо принять актуальные версии обязательных документов',
      fieldErrors: missing.map((kind) => ({ path: `consents.${kind}`, message: 'не принят' })),
    }),

  reacceptRequired: () =>
    new AppError(ErrorCode.REACCEPT_REQUIRED, {
      publicDetail: 'Условия обновились. Примите новую версию, чтобы продолжить платные операции',
    }),

  subscriptionRequired: () =>
    new AppError(ErrorCode.SUBSCRIPTION_REQUIRED, {
      publicDetail: 'Доступ открывается активной подпиской',
    }),

  kycRequired: () =>
    new AppError(ErrorCode.KYC_REQUIRED, { publicDetail: 'Требуется пройти верификацию' }),

  /**
   * Отсутствие ресурса и отсутствие прав на него возвращают ОДИН и тот же
   * ответ. Иначе 403 против 404 превращается в оракул существования объекта.
   */
  notFound: (internal?: Record<string, unknown>) =>
    new AppError(ErrorCode.NOT_FOUND, { publicDetail: 'Не найдено', internal }),

  conflict: (publicDetail: string, internal?: Record<string, unknown>) =>
    new AppError(ErrorCode.CONFLICT, { publicDetail, internal }),

  idempotencyKeyReused: () =>
    new AppError(ErrorCode.IDEMPOTENCY_KEY_REUSED, {
      publicDetail: 'Этот ключ идемпотентности уже использован с другими параметрами',
    }),

  validation: (fieldErrors: { path: string; message: string }[]) =>
    new AppError(ErrorCode.VALIDATION_FAILED, {
      publicDetail: 'Проверьте правильность заполнения полей',
      fieldErrors,
    }),

  limitExceeded: (publicDetail: string) => new AppError(ErrorCode.LIMIT_EXCEEDED, { publicDetail }),

  selfDeal: () =>
    new AppError(ErrorCode.SELF_DEAL_FORBIDDEN, {
      publicDetail: 'Нельзя инвестировать в проект, к которому вы имеете отношение',
    }),

  stateTransition: (publicDetail: string) =>
    new AppError(ErrorCode.STATE_TRANSITION_NOT_ALLOWED, { publicDetail }),

  /**
   * Внешняя зависимость недоступна. Наружу — без имени и адреса зависимости в
   * тексте: это подсказка о внутреннем устройстве.
   */
  upstreamUnavailable: (dependency: string) =>
    new AppError(ErrorCode.DEPENDENCY_UNAVAILABLE, {
      publicDetail: 'Сервис временно недоступен, попробуйте позже',
      internal: { dependency },
    }),

  /**
   * Данные нельзя передать за пределы разрешённых юрисдикций. Повтор запроса
   * бессмысленен: это запрет, а не сбой, и клиент обязан их различать.
   */
  residencyViolation: () =>
    new AppError(ErrorCode.RESIDENCY_VIOLATION, {
      publicDetail: 'Обработка этих данных за пределами разрешённого контура запрещена',
    }),

  featureDisabled: (flag: string) =>
    new AppError(ErrorCode.FEATURE_DISABLED, {
      publicDetail: 'Функция пока недоступна',
      internal: { flag },
    }),

  internal: (internal?: Record<string, unknown>, cause?: unknown) =>
    new AppError(ErrorCode.INTERNAL_ERROR, {
      publicDetail: 'Внутренняя ошибка. Обратитесь в поддержку с идентификатором запроса',
      internal,
      cause,
    }),
};
