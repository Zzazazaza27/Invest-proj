import { z } from 'zod';
import {
  boundedString,
  CurrencySchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives';

/**
 * Регулируемый контур ОИП.
 *
 * Всё здесь включается ТОЛЬКО после гейта A: включения юрлица в реестр ОИП
 * Банка России и согласования Правил платформы. До этого эндпоинты закрыты
 * feature flag'ом и возвращают FEATURE_DISABLED.
 */

/**
 * Способ инвестирования — серверный allowlist из согласованных Правил, а не
 * свободный параметр клиента (docs/architecture/Architect_Launch.md §5.5). Каждый тип
 * дополнительно закрыт собственным флагом.
 */
export const InstrumentTypeSchema = z.enum(['loan', 'security', 'utility_digital_right', 'dfa']);
export type InstrumentType = z.infer<typeof InstrumentTypeSchema>;

export const OfferStatusSchema = z.enum([
  'draft',
  'compliance_review',
  'published',
  'paused',
  'closed',
  'cancelled',
]);

export const InvestmentOfferSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  issuerEntityId: UuidSchema,
  instrumentType: InstrumentTypeSchema,
  rulesVersion: z.string(),
  targetAmount: z.string(),
  minInvestment: z.string(),
  currency: CurrencySchema,
  status: OfferStatusSchema,
  opensAt: IsoDateTimeSchema.nullable(),
  closesAt: IsoDateTimeSchema.nullable(),
  /** Сколько уже законтрактовано. Нужен инвестору, чтобы видеть остаток. */
  committedAmount: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type InvestmentOffer = z.infer<typeof InvestmentOfferSchema>;

export const CreateOfferRequestSchema = z.object({
  projectId: UuidSchema,
  issuerEntityId: UuidSchema,
  instrumentType: InstrumentTypeSchema,
  targetAmount: MoneyAmountSchema,
  minInvestment: MoneyAmountSchema,
  currency: CurrencySchema,
  terms: z.record(z.string(), z.unknown()),
  opensAt: IsoDateTimeSchema.optional(),
  closesAt: IsoDateTimeSchema.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type CreateOfferRequest = z.infer<typeof CreateOfferRequestSchema>;

export const AgreementStatusSchema = z.enum([
  'pending_signatures',
  'signed',
  'awaiting_first_tranche',
  'effective',
  'completed',
  'cancelled',
  'defaulted',
]);
export type AgreementStatus = z.infer<typeof AgreementStatusSchema>;

/**
 * Принятие инвестиционного предложения.
 *
 * Требует step-up MFA (docs/architecture/Architect_Launch.md §7) и подтверждения, что инвестор
 * ознакомлен с последствием: вознаграждение начисляется от ПОЛНОЙ суммы
 * договора однократно и не пересчитывается при непоступлении следующих траншей.
 */
export const AcceptOfferRequestSchema = z.object({
  offerId: UuidSchema,
  contractAmount: MoneyAmountSchema,
  currency: CurrencySchema,
  idempotencyKey: IdempotencyKeySchema,
  /** Явное подтверждение раскрытия последствий. Без него — 422. */
  acknowledgedFeeDisclosure: z.literal(true),
  acknowledgedRulesVersion: boundedString(1, 64),
});
export type AcceptOfferRequest = z.infer<typeof AcceptOfferRequestSchema>;

export const InvestmentAgreementSchema = z.object({
  id: UuidSchema,
  offerId: UuidSchema,
  projectId: UuidSchema,
  investorId: UuidSchema,
  contractAmount: z.string(),
  currency: CurrencySchema,
  feeScheduleId: UuidSchema,
  status: AgreementStatusSchema,
  investorSignedAt: IsoDateTimeSchema.nullable(),
  issuerSignedAt: IsoDateTimeSchema.nullable(),
  effectiveAt: IsoDateTimeSchema.nullable(),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: IsoDateTimeSchema,
});
export type InvestmentAgreement = z.infer<typeof InvestmentAgreementSchema>;

/** Подписание. Тоже step-up MFA. */
export const SignAgreementRequestSchema = z.object({
  agreementId: UuidSchema,
  /** Хеш документа, который пользователь фактически видел. */
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  idempotencyKey: IdempotencyKeySchema,
});
export type SignAgreementRequest = z.infer<typeof SignAgreementRequestSchema>;

export const TrancheStatusSchema = z.enum([
  'scheduled',
  'received_nominal',
  'transferred_to_issuer',
  'confirmed',
  'returned',
  'failed',
  'disputed',
]);

export const InvestmentTrancheSchema = z.object({
  id: UuidSchema,
  agreementId: UuidSchema,
  trancheNo: z.number().int().positive(),
  amount: z.string(),
  currency: CurrencySchema,
  status: TrancheStatusSchema,
  receivedNominalAt: IsoDateTimeSchema.nullable(),
  transferredAt: IsoDateTimeSchema.nullable(),
  confirmedAt: IsoDateTimeSchema.nullable(),
});
export type InvestmentTranche = z.infer<typeof InvestmentTrancheSchema>;

/**
 * Событие банка по номинальному счёту.
 *
 * ЭТО НЕ КЛИЕНТСКИЙ ЭНДПОИНТ. Схема описывает вход вебхука от банка; он
 * принимается только с проверенной HMAC-подписью и timestamp в допустимом окне.
 * Подтвердить транш иным способом нельзя — ни через API, ни ролью app_backend
 * (docs/architecture/Architect_Launch.md §7).
 */
export const NominalAccountWebhookSchema = z.object({
  agreementId: UuidSchema,
  bankTransactionRef: boundedString(6, 128),
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
  direction: z.enum(['incoming', 'to_issuer', 'return_to_investor']),
  bookedAt: IsoDateTimeSchema,
  statementSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type NominalAccountWebhook = z.infer<typeof NominalAccountWebhookSchema>;
