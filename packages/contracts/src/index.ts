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

export * from './common/primitives.ts';
export * from './common/problem.ts';
export * from './common/pagination.ts';

export * from './domain/identity.ts';
export * from './domain/lab.ts';
export * from './domain/billing.ts';
export * from './domain/investments.ts';
export * from './domain/misc.ts';

export * from './events.ts';

/** Версия контракта API. Меняется вместе с несовместимыми изменениями. */
export const API_VERSION = 'v1' as const;

/** Скоупы Integration API (service-to-service). Строгий allowlist. */
export const INTEGRATION_SCOPES = [
  'graduates:read',
  'passport:read',
  'listing:create',
  'deals:read',
  'show:read',
  'webhooks:manage',
  'seasons:read',
] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

/**
 * Операции, требующие step-up MFA (Architect_Launch.md §7).
 * Сервер проверяет `acr` токена; список продублирован здесь, чтобы фронтенд
 * мог заранее инициировать повышение уровня, а не ловить 403.
 */
export const STEP_UP_OPERATIONS = [
  'investments.acceptOffer',
  'investments.signAgreement',
  'billing.updatePaymentDetails',
  'identity.changeMfa',
] as const;
export type StepUpOperation = (typeof STEP_UP_OPERATIONS)[number];
