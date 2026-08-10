import { z } from 'zod';
import {
  CurrencySchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives.ts';

/**
 * Биллинг — ВЫРУЧКА ПЛАТФОРМЫ и только она: подписки и вознаграждение ОИП.
 * Инвестиционный principal живёт в `investments` и сюда не попадает (ADR-005).
 */

export const PlanCodeSchema = z.enum([
  'founder_t1',
  'founder_t2',
  'founder_t3',
  'founder_t4',
  'founder_t5',
  'investor_membership',
]);
export type PlanCode = z.infer<typeof PlanCodeSchema>;

export const PlanAudienceSchema = z.enum(['founder', 'investor']);

/**
 * Тарифная сетка публикуется открыто, без авторизации — принцип радикальной
 * прозрачности (Architect_Launch.md §5.4).
 */
export const SubscriptionPlanSchema = z.object({
  id: UuidSchema,
  code: PlanCodeSchema,
  version: z.number().int().positive(),
  audience: PlanAudienceSchema,
  name: z.string(),
  /** Верхняя граница investment_ask. null — «свыше» (t5) или неприменимо. */
  askLimit: z.string().nullable(),
  individualPricing: z.boolean(),
  price: z.string().nullable(),
  currency: CurrencySchema,
  billingPeriod: z.enum(['monthly', 'yearly']),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
});
export type SubscriptionPlan = z.infer<typeof SubscriptionPlanSchema>;

/** Условия вознаграждения ОИП. Тоже публичны. */
export const FeeScheduleSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  version: z.number().int().positive(),
  investorFeePct: z.string(),
  issuerFeePct: z.string(),
  rulesVersion: z.string(),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
});
export type FeeSchedule = z.infer<typeof FeeScheduleSchema>;

/** Публичная витрина цен: одним запросом, без авторизации. */
export const PricingSchema = z.object({
  plans: z.array(SubscriptionPlanSchema),
  feeSchedule: FeeScheduleSchema,
  /**
   * Текст, который обязателен к показу до регистрации: база вознаграждения —
   * полная сумма договора, начисление однократное.
   */
  feeDisclosure: z.object({
    baseIsFullContractAmount: z.literal(true),
    accrualIsOneTime: z.literal(true),
    triggerDescription: z.string(),
  }),
});
export type Pricing = z.infer<typeof PricingSchema>;

export const SubscriptionStatusSchema = z.enum([
  'pending_payment',
  'active',
  'past_due',
  'canceled',
  'expired',
]);

export const SubscriptionSchema = z.object({
  id: UuidSchema,
  planId: UuidSchema,
  planCode: PlanCodeSchema,
  projectId: UuidSchema.nullable(),
  priceSnapshot: z.string(),
  currency: CurrencySchema,
  status: SubscriptionStatusSchema,
  currentPeriodEnd: IsoDateTimeSchema.nullable(),
  graceUntil: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/**
 * Оформление подписки. Тариф основателя резолвится сервером из investment_ask
 * проекта — клиент передаёт проект, а не план: иначе цену можно было бы
 * занизить, подставив чужой planId.
 */
export const CreateSubscriptionRequestSchema = z.discriminatedUnion('audience', [
  z.object({
    audience: z.literal('founder'),
    projectId: UuidSchema,
    idempotencyKey: IdempotencyKeySchema,
  }),
  z.object({
    audience: z.literal('investor'),
    idempotencyKey: IdempotencyKeySchema,
  }),
]);
export type CreateSubscriptionRequest = z.infer<typeof CreateSubscriptionRequestSchema>;

export const InvoiceStatusSchema = z.enum([
  'issued',
  'partially_paid',
  'paid',
  'overdue',
  'void',
  'adjusted',
]);

export const InvoiceSchema = z.object({
  id: UuidSchema,
  number: z.string(),
  payerRole: z.enum(['account', 'investor', 'issuer']),
  subscriptionId: UuidSchema.nullable(),
  accrualId: UuidSchema.nullable(),
  amountDue: z.string(),
  currency: CurrencySchema,
  status: InvoiceStatusSchema,
  issuedAt: IsoDateTimeSchema,
  dueAt: IsoDateTimeSchema,
});
export type Invoice = z.infer<typeof InvoiceSchema>;

/**
 * Начисление вознаграждения ОИП.
 *
 * `baseAmount` — ПОЛНАЯ сумма договора, а не размер транша. Начисление
 * возникает ровно один раз, по составному триггеру: обе подписи + подтверждённый
 * банковским событием первый транш (ADR-005).
 */
export const CommissionAccrualSchema = z.object({
  id: UuidSchema,
  agreementId: UuidSchema,
  baseAmount: z.string(),
  currency: CurrencySchema,
  investorFeePct: z.string(),
  issuerFeePct: z.string(),
  investorFeeAmount: z.string(),
  issuerFeeAmount: z.string(),
  status: z.enum(['accrued', 'invoiced', 'partially_paid', 'paid', 'disputed', 'adjusted']),
  accruedAt: IsoDateTimeSchema,
});
export type CommissionAccrual = z.infer<typeof CommissionAccrualSchema>;

/** Платёж в пользу платформы. Идемпотентность обязательна. */
export const CreatePaymentRequestSchema = z.object({
  invoiceId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: CurrencySchema,
  idempotencyKey: IdempotencyKeySchema,
  returnUrl: z.url().optional(),
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequestSchema>;

export const PaymentSchema = z.object({
  id: UuidSchema,
  invoiceId: UuidSchema,
  amount: z.string(),
  currency: CurrencySchema,
  status: z.enum([
    'pending',
    'authorized',
    'succeeded',
    'failed',
    'partially_refunded',
    'refunded',
    'chargeback',
  ]),
  /** URL страницы оплаты провайдера, если требуется редирект. */
  confirmationUrl: z.url().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Payment = z.infer<typeof PaymentSchema>;
