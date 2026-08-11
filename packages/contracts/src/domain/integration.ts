import { z } from 'zod';
import { boundedString, IsoDateTimeSchema, UuidSchema } from '../common/primitives';

/**
 * Integration API — контракт для ВНЕШНИХ систем (Unicorn Capital, медиаконтур
 * Шоу), а не для фронтендов платформы.
 *
 * Два свойства отличают его от остальных контрактов и определяют всё
 * остальное:
 *
 *  1. **Здесь нет персональных данных.** Наружу уходят агрегаты и обезличенные
 *     проекции: имя инвестора, его контакты и документы за периметр не выходят
 *     ни в каком виде, даже под скоупом `deals:read`.
 *  2. **Совместимость только расширением.** Потребитель — чужая система с
 *     собственным циклом релизов; удаление поля или смена типа ломает её
 *     молча. Поэтому у каждого ответа есть `dataVersion`.
 */

/** Версия схемы данных ответа. Растёт при расширении, не при правке значений. */
export const INTEGRATION_DATA_VERSION = 1;

export const IntegrationTokenRequestSchema = z.object({
  clientId: boundedString(3, 128),
  clientSecret: boundedString(32, 512),
});
export type IntegrationTokenRequest = z.infer<typeof IntegrationTokenRequestSchema>;

export const IntegrationTokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  scopes: z.array(z.string()),
});
export type IntegrationTokenResponse = z.infer<typeof IntegrationTokenResponseSchema>;

/**
 * Выпускник, готовый к расширенным листингам на Capital.
 * ПДн основателей здесь нет — только проект и его публичные показатели.
 */
export const GraduateSchema = z.object({
  projectId: UuidSchema,
  title: z.string(),
  seasonId: UuidSchema.nullable(),
  taxonomyId: UuidSchema.nullable(),
  stage: z.string(),
  investmentAsk: z.string(),
  currency: z.literal('RUB'),
  irs: z.number().min(0).max(100).nullable(),
  graduatedAt: IsoDateTimeSchema.nullable(),
  /** Ссылка на уже созданный листинг во внешней системе, если он есть. */
  externalRef: z.string().nullable(),
});
export type Graduate = z.infer<typeof GraduateSchema>;

export const IrsHistoryEntrySchema = z.object({
  value: z.number().min(0).max(100),
  previousValue: z.number().min(0).max(100).nullable(),
  delta: z.number().nullable(),
  computedAt: IsoDateTimeSchema,
});
export type IrsHistoryEntry = z.infer<typeof IrsHistoryEntrySchema>;

/**
 * Агрегат по договорам инвестирования. Ни идентификатора инвестора, ни
 * идентификатора ЛПИ: потребителю нужен объём и динамика, а не стороны сделки.
 */
export const IntegrationDealSchema = z.object({
  agreementId: UuidSchema,
  projectId: UuidSchema,
  status: z.string(),
  amount: z.string(),
  currency: z.literal('RUB'),
  instrumentType: z.string(),
  signedAt: IsoDateTimeSchema.nullable(),
  effectiveAt: IsoDateTimeSchema.nullable(),
  /**
   * Вознаграждение платформы по сделке. `null` — начисления ещё нет: оно
   * возникает вместе с подтверждённым первым траншем, и до этого момента ноль
   * означал бы «комиссия нулевая», а не «сделка ещё не оплачена».
   *
   * Данные приходят из проекции `integration.deal_commissions`, которую
   * наполняет биллинг: интеграционная роль денежных таблиц не читает.
   */
  commission: z
    .object({
      baseAmount: z.string(),
      investorFeeAmount: z.string(),
      issuerFeeAmount: z.string(),
      totalFeeAmount: z.string(),
      accruedAt: IsoDateTimeSchema,
    })
    .nullable(),
});
export type IntegrationDeal = z.infer<typeof IntegrationDealSchema>;

/**
 * Обезличенная проекция для медиаконтура. Отдаётся ТОЛЬКО при действующем
 * согласии на публичность: отозвали согласие — проекция исчезает, а не
 * «перестаёт обновляться».
 */
export const PublicProfileSchema = z.object({
  projectId: UuidSchema,
  title: z.string(),
  stage: z.string(),
  taxonomyId: UuidSchema.nullable(),
  irs: z.number().min(0).max(100).nullable(),
  seasonNumber: z.number().int().positive().nullable(),
  consentScope: z.string(),
  consentGrantedAt: IsoDateTimeSchema,
});
export type PublicProfile = z.infer<typeof PublicProfileSchema>;

/** Регистрация листинга выпускника во внешней системе. */
export const CreateListingRefRequestSchema = z.object({
  projectId: UuidSchema,
  remoteSystem: boundedString(2, 64),
  remoteType: boundedString(2, 64),
  remoteId: boundedString(1, 200),
});
export type CreateListingRefRequest = z.infer<typeof CreateListingRefRequestSchema>;

export const ExternalRefSchema = z.object({
  id: UuidSchema,
  localType: z.string(),
  localId: UuidSchema,
  remoteSystem: z.string(),
  remoteType: z.string(),
  remoteId: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type ExternalRef = z.infer<typeof ExternalRefSchema>;

/**
 * Подписка на события по HTTPS.
 *
 * Адрес проверяется и схемой, и ограничением таблицы: приватные диапазоны и
 * адреса метаданных облака запрещены — иначе подписка на собственный вебхук
 * превращается в SSRF из-под сервера платформы.
 */
export const CreateWebhookRequestSchema = z.object({
  url: z
    .string()
    .url()
    .max(2000)
    .refine((value) => value.startsWith('https://'), { message: 'только https' }),
  subscribedVerbs: z.array(boundedString(3, 100)).min(1).max(50),
});
export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const WebhookEndpointSchema = z.object({
  id: UuidSchema,
  url: z.string(),
  subscribedVerbs: z.array(z.string()),
  status: z.enum(['active', 'paused', 'disabled']),
  createdAt: IsoDateTimeSchema,
});
export type WebhookEndpoint = z.infer<typeof WebhookEndpointSchema>;

/**
 * Секрет подписи вебхука возвращается РОВНО ОДИН РАЗ — в ответе на создание.
 * Дальше он хранится зашифрованным, и «показать ещё раз» невозможно by design:
 * потерял — ротируй.
 */
export const WebhookCreatedSchema = WebhookEndpointSchema.extend({
  signingSecret: z.string(),
});
export type WebhookCreated = z.infer<typeof WebhookCreatedSchema>;

// ------------------------------------------------- управление аккаунтами (admin)

export const CreateServiceAccountRequestSchema = z.object({
  name: boundedString(2, 200),
  clientId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/, 'строчные латинские буквы, цифры, ._-'),
  scopes: z.array(boundedString(3, 40)).min(1).max(20),
  /** Отпечаток клиентского сертификата (sha256 в hex) для mTLS. */
  mtlsCertFingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'ожидается sha256 в hex'),
});
export type CreateServiceAccountRequest = z.infer<typeof CreateServiceAccountRequestSchema>;

export const ServiceAccountSchema = z.object({
  id: UuidSchema,
  clientId: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'suspended']),
  createdAt: IsoDateTimeSchema,
  rotatedAt: IsoDateTimeSchema.nullable(),
});
export type ServiceAccount = z.infer<typeof ServiceAccountSchema>;

/** Секрет отдаётся один раз — при создании и при ротации. */
export const ServiceAccountWithSecretSchema = ServiceAccountSchema.extend({
  clientSecret: z.string(),
});
export type ServiceAccountWithSecret = z.infer<typeof ServiceAccountWithSecretSchema>;

/** Конверт постраничного ответа Integration API. */
export function integrationPage<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    dataVersion: z.number().int().positive(),
  });
}
