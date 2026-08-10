import { z } from 'zod';
import {
  CurrencySchema,
  IdempotencyKeySchema,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives';

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
  /**
   * Объявленные изменения тарифов — версии, которые ещё не вступили в силу.
   *
   * Публикуются открыто и заранее: цена, о которой пользователь узнаёт в момент
   * списания, противоречит принципу радикальной прозрачности (Architect_Launch
   * §5.4). Здесь видно и новую цену, и дату, с которой она начнёт действовать.
   */
  announcedPlans: z.array(SubscriptionPlanSchema),
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

// --------------------------------------------------- административное управление

/**
 * Версия тарифа глазами администратора: то же, что и в публичной витрине, плюс
 * состав («наполнение» подписки) и признак, можно ли ещё править эту версию.
 */
export const AdminPlanSchema = SubscriptionPlanSchema.extend({
  features: z.record(z.string(), z.unknown()),
  /** true — версия уже действует или действовала: денежные условия заморожены. */
  isLocked: z.boolean(),
  /** Активна ли версия прямо сейчас (продаётся). */
  isActive: z.boolean(),
  subscriptionsCount: z.number().int().nonnegative(),
});
export type AdminPlan = z.infer<typeof AdminPlanSchema>;

/**
 * Публикация новой версии тарифа.
 *
 * Изменение цены действующего тарифа — это именно публикация НОВОЙ версии:
 * прежняя закрывается тем же моментом, с которого начинает действовать новая.
 * Переписать цену, под которой уже подписались, нельзя ни через API, ни в БД
 * (ADR-005, триггер `subscription_plans_history_immutable`).
 */
export const PublishPlanRequestSchema = z
  .object({
    code: PlanCodeSchema,
    audience: PlanAudienceSchema,
    name: z.string().trim().min(2).max(160),
    /** Верхняя граница `investment_ask`. null — без ограничения (t5). */
    askLimit: MoneyAmountSchema.nullable().optional(),
    price: MoneyAmountSchema.nullable().optional(),
    individualPricing: z.boolean().default(false),
    billingPeriod: z.enum(['monthly', 'yearly']).default('monthly'),
    /** Состав подписки: что входит. Показывается на витрине и в кабинете. */
    features: z.record(z.string(), z.unknown()).default({}),
    /** С какого момента версия действует. Прошлое недопустимо. */
    validFrom: IsoDateTimeSchema.optional(),
  })
  .refine((v) => v.individualPricing || Boolean(v.price), {
    message: 'нужна цена либо признак индивидуального ценообразования',
    path: ['price'],
  })
  .refine((v) => !(v.individualPricing && v.price), {
    message: 'у индивидуального тарифа не может быть фиксированной цены',
    path: ['price'],
  });
export type PublishPlanRequest = z.infer<typeof PublishPlanRequestSchema>;

/** Правка версии, которая ещё не вступила в силу. Действующую править нельзя. */
export const UpdateDraftPlanRequestSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  askLimit: MoneyAmountSchema.nullable().optional(),
  price: MoneyAmountSchema.nullable().optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  validFrom: IsoDateTimeSchema.optional(),
});
export type UpdateDraftPlanRequest = z.infer<typeof UpdateDraftPlanRequestSchema>;

/** Снятие тарифа с продажи. Существующие подписки продолжают действовать. */
export const ClosePlanRequestSchema = z.object({
  /** Момент закрытия. По умолчанию — сейчас. */
  validTo: IsoDateTimeSchema.optional(),
  reason: z.string().trim().min(3).max(500),
});
export type ClosePlanRequest = z.infer<typeof ClosePlanRequestSchema>;

/**
 * Индивидуальная цена. Двухшаговая по требованию 4-eyes: назначает один
 * администратор, утверждает другой. Совпадение назначившего и утвердившего
 * запрещено CHECK-ограничением в БД, а не только проверкой в коде.
 */
export const ProposeCustomPriceRequestSchema = z.object({
  price: MoneyAmountSchema,
  reason: z.string().trim().min(3).max(500),
});
export type ProposeCustomPriceRequest = z.infer<typeof ProposeCustomPriceRequestSchema>;

export const AdminSubscriptionSchema = SubscriptionSchema.extend({
  userId: UuidSchema,
  userDisplayName: z.string(),
  projectTitle: z.string().nullable(),
  customPrice: z.string().nullable(),
  customPriceSetBy: UuidSchema.nullable(),
  customPriceApprovedBy: UuidSchema.nullable(),
});
export type AdminSubscription = z.infer<typeof AdminSubscriptionSchema>;

export const FeatureFlagSchema = z.object({
  key: z.string(),
  enabled: z.boolean(),
  rules: z.record(z.string(), z.unknown()),
  updatedAt: IsoDateTimeSchema,
});
export type FeatureFlag = z.infer<typeof FeatureFlagSchema>;

export const UpdateFeatureFlagRequestSchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});
export type UpdateFeatureFlagRequest = z.infer<typeof UpdateFeatureFlagRequestSchema>;

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
