/**
 * @unicorn/contracts — единственный источник правды контрактов UNICORN LAUNCH.
 *
 * Эти схемы валидируют запросы на сервере И типизируют клиент. Пакет НЕ
 * зависит ни от React, ни от NestJS, ни от драйвера БД: он существует именно
 * для того, чтобы фронтенд можно было выбросить и переписать, не трогая
 * бэкенд (ADR-002).
 *
 * Что здесь НЕ должно появляться:
 *  - бизнес-логика (она на сервере, здесь только форма данных);
 *  - обращения к сети, БД, файловой системе;
 *  - секреты и ключи.
 */

export * from './common/primitives';
export * from './common/problem';
export * from './common/pagination';

export * from './domain/identity';
export * from './domain/lab';
export * from './domain/platform';
export * from './domain/project-views';
export * from './domain/project-access';
export * from './domain/visibility';
export * from './domain/service-country';
export * from './domain/content';
export * from './domain/project-media';
export * from './domain/staff-capabilities';
export * from './domain/admin-users';
export * from './domain/profile';
export * from './domain/testing-sessions';
export * from './domain/integration';
export * from './domain/support';
export * from './domain/misc';

export * from './events';

/** Версия контракта API. Меняется вместе с несовместимыми изменениями. */
export const API_VERSION = 'v1' as const;

/**
 * Скоупы Integration API (service-to-service). Строгий allowlist.
 *
 * С 2.1-W05 остался только общий механизм — управление подписками на события.
 * Выдачи выпускников, паспорта, листингов, сделок, шоу и сезона удалены вместе
 * с процессами, на которых держались.
 */
export const INTEGRATION_SCOPES = ['webhooks:manage'] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/**
 * Какие события доступны какому скоупу (префиксы глаголов).
 *
 * `webhooks:manage` в карте НЕТ намеренно: он даёт право УПРАВЛЯТЬ подписками,
 * а не читать данные. На какие события можно подписаться, решают скоупы,
 * открывающие эти данные по REST; сейчас таких нет — подписаться не на что,
 * пока новые выдачи не спроектированы заново.
 */
export const SCOPE_EVENT_PREFIXES: Record<string, readonly string[]> = {};

/** Разрешён ли глагол хотя бы одним из скоупов аккаунта. */
export function verbAllowedByScopes(verb: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) =>
    (SCOPE_EVENT_PREFIXES[scope] ?? []).some((prefix) => verb.startsWith(prefix)),
  );
}

/**
 * Операции, требующие step-up MFA (docs/architecture/Architect_Launch.md §7).
 * Сервер проверяет `acr` токена; список продублирован здесь, чтобы фронтенд
 * мог заранее инициировать повышение уровня, а не ловить 403.
 */
export const STEP_UP_OPERATIONS = ['identity.changeMfa'] as const;
export type StepUpOperation = (typeof STEP_UP_OPERATIONS)[number];
