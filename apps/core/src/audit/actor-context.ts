import { uuidv7 } from '@fifth/contracts';

/**
 * Общий контекст автора действия (блок 10, задание 1; docs/architecture/b10-actor-context.md).
 *
 * Контекст ПРАВ НЕ ДАЁТ: он записывает то, что уже проверено. Ни одну проверку
 * объекта, полномочия или RLS он не заменяет и сам ничего не разрешает.
 */

export type ActorKind = 'person' | 'service_account' | 'anonymous' | 'system';

/** Фактически пройденная проверка. Роль сама по себе основанием не считается. */
export type Basis =
  | { check: 'route-role'; role: string }
  | { check: 'member'; object: string }
  | { check: 'self' }
  | { check: 'token-purpose'; purpose: string }
  | { check: 'service-scope'; scope: string }
  | { check: 'job'; name: string }
  | { check: 'public' };

export interface Initiator {
  kind: ActorKind;
  userId?: string | null;
  serviceAccountId?: string | null;
}

/** Сохранённое происхождение операции — то, что фон берёт из своей очереди. */
export interface Origin {
  operationId: string;
  initiator: Initiator | null;
  requestId: string | null;
}

export interface ActorScope {
  /** Одна операция пользователя: переживает повторы и продолжение в фоне. */
  operationId: string;
  /** Пополняется по мере прохождения проверок; разделяется копиями контекста. */
  basis: Basis[];
  kind?: ActorKind;
  serviceAccountId?: string | null;
  job?: { name: string; runId: string; attempt: number } | null;
  initiator?: Initiator | null;
  originUnknown?: boolean;
}

/** Форма, которая ложится в `context_jsonb.actor` (версия 1). */
export interface ActorRecord {
  v: 1;
  kind: ActorKind;
  userId: string | null;
  serviceAccountId: string | null;
  role: string;
  basis: Basis[];
  onBehalfOf: string | null;
  testSessionId: string | null;
  viewMode: boolean;
  operationId: string;
  requestId: string | null;
  job: { name: string; runId: string; attempt: number } | null;
  initiator: Initiator | null;
  originUnknown?: true;
}

export function newScope(basis: Basis[] = []): ActorScope {
  return { operationId: uuidv7(), basis };
}

/** Фоновая работа: автор — система, автор операции — из сохранённого происхождения. */
export function jobScope(
  name: string,
  runId: string,
  origin?: Origin | null,
  attempt = 1,
): ActorScope {
  return {
    operationId: origin?.operationId ?? uuidv7(),
    basis: [{ check: 'job', name }],
    kind: 'system',
    job: { name, runId, attempt },
    initiator: origin?.initiator ?? null,
    // Старая строка очереди без происхождения: автора операции не выдумываем.
    ...(origin === null ? { originUnknown: true } : {}),
  };
}

/** Отметить пройденную проверку. Дубликаты не копятся. */
export function noteBasis(scope: ActorScope | undefined, basis: Basis): void {
  if (!scope) return;
  const key = JSON.stringify(basis);
  if (!scope.basis.some((b) => JSON.stringify(b) === key)) scope.basis.push(basis);
}

/** Роль журнала из основания. Разные роли у разных оснований — отказ, а не выбор «старшей». */
export function roleFromBasis(basis: readonly Basis[], kind: ActorKind): string | null {
  const roles = new Set<string>();
  for (const b of basis) {
    if (b.check === 'route-role') roles.add(b.role);
    else if (b.check === 'member') roles.add('founder');
    else if (b.check === 'self') roles.add('user');
    else if (b.check === 'service-scope') roles.add('service');
    else if (b.check === 'job') roles.add('system');
    else if ((b.check === 'public' || b.check === 'token-purpose') && kind === 'anonymous')
      roles.add('anonymous');
  }
  if (roles.size > 1) {
    throw new Error(`журнал: основания дают разные роли (${[...roles].join(', ')})`);
  }
  return roles.values().next().value ?? null;
}

/** Происхождение операции для сохранения в очереди фона. */
export function originOf(ctx: {
  userId: string | null;
  traceId: string;
  actor?: ActorScope;
}): Origin {
  const scope = ctx.actor;
  const kind: ActorKind =
    scope?.kind ?? (ctx.userId ? 'person' : scope?.serviceAccountId ? 'service_account' : 'anonymous');
  return {
    operationId: scope?.operationId ?? uuidv7(),
    initiator: scope?.initiator ?? {
      kind,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
      ...(scope?.serviceAccountId ? { serviceAccountId: scope.serviceAccountId } : {}),
    },
    requestId: ctx.traceId,
  };
}

/**
 * Уточнить основание после проверки объекта: снимает «роль маршрута» и ставит то,
 * что фактически пропустило действие. Так у человека с двумя ролями роль в журнале
 * следует из проверки, а не из того, какая роль в списке старше.
 */
export function settleBasis(scope: ActorScope | undefined, basis: Basis): void {
  if (!scope) return;
  scope.basis = scope.basis.filter((b) => b.check !== 'route-role');
  noteBasis(scope, basis);
}

/**
 * Действие человека над собственной учётной записью (профиль, пароль, устройства,
 * своя проверка личности). Роль журнала — `user`: основание — «это он сам», а не
 * какая-то из его ролей; прежнее «первая роль из списка» было случайным.
 */
export function actingSelf(ctx: { actor?: ActorScope }): 'user' {
  settleBasis(ctx.actor, { check: 'self' });
  return 'user';
}
