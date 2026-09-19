import { z } from 'zod';
import { IsoDateTimeSchema, MoneyAmountSchema, UuidSchema } from '../common/primitives';
import { PolicyCurrencySchema } from './service-country';

/**
 * Функциональные полномочия сотрудника и ручные денежные записи (M097).
 *
 * Два НЕЗАВИСИМЫХ слоя доступа:
 *
 *   1. полномочие — какое действие сотрудник вправе делать вообще;
 *   2. область работы — с какими объектами он работает (назначение на
 *      проект, `experts.expert_assignments`).
 *
 * Право фиксировать возврат не открывает все сделки платформы, а назначение
 * на проект не даёт права трогать комиссию. Роль `expert` сама по себе не
 * означает ни того, ни другого; невыданное полномочие запрещено.
 */

export const CapabilityCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/, 'код полномочия: разделы через точку');

/** Вид действия: просмотр и денежная корректировка — разные полномочия. */
export const CapabilityActionSchema = z.enum([
  'view',
  'create',
  'update',
  'confirm',
  'financial_adjust',
  'discuss',
]);

export const StaffCapabilitySchema = z.object({
  code: CapabilityCodeSchema,
  section: z.string(),
  action: CapabilityActionSchema,
  title: z.string(),
  description: z.string(),
  /** Полномочие реализовано: проверка на него есть в коде. */
  isImplemented: z.boolean(),
  /** Требует области работы — назначения на конкретный объект. */
  requiresAssignment: z.boolean(),
});
export type StaffCapability = z.infer<typeof StaffCapabilitySchema>;

export const StaffCapabilityGrantSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  capability: CapabilityCodeSchema,
  reason: z.string(),
  grantedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type StaffCapabilityGrant = z.infer<typeof StaffCapabilityGrantSchema>;

export const GrantCapabilityRequestSchema = z.object({
  userId: UuidSchema,
  capability: CapabilityCodeSchema,
  reason: z.string().trim().min(3).max(500),
});
export type GrantCapabilityRequest = z.infer<typeof GrantCapabilityRequestSchema>;

export const RevokeCapabilityRequestSchema = z.object({
  userId: UuidSchema,
  capability: CapabilityCodeSchema,
  reason: z.string().trim().min(3).max(500),
});
export type RevokeCapabilityRequest = z.infer<typeof RevokeCapabilityRequestSchema>;

/**
 * Назначение на сопровождение сделок проекта (M099).
 *
 * Область работы для денежных действий. НЕ делает сотрудника рецензентом:
 * анкета, внутренние оценки и материалы проекта им не открываются.
 */
export const DealSupportAssignmentSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  userId: UuidSchema,
  status: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type DealSupportAssignment = z.infer<typeof DealSupportAssignmentSchema>;

export const AssignDealSupportRequestSchema = z.object({
  projectId: UuidSchema,
  userId: UuidSchema,
  reason: z.string().trim().min(3).max(500),
});
export type AssignDealSupportRequest = z.infer<typeof AssignDealSupportRequestSchema>;

export const RevokeDealSupportRequestSchema = z.object({
  projectId: UuidSchema,
  userId: UuidSchema,
  reason: z.string().trim().min(3).max(500),
});
export type RevokeDealSupportRequest = z.infer<typeof RevokeDealSupportRequestSchema>;

/**
 * Строка списка назначений на сопровождение. Имена рядом с идентификаторами:
 * администратор снимает назначение у человека с проекта, а не у UUID с UUID.
 */
export const DealSupportAssignmentRowSchema = DealSupportAssignmentSchema.extend({
  projectTitle: z.string(),
  userName: z.string(),
});
export type DealSupportAssignmentRow = z.infer<typeof DealSupportAssignmentRowSchema>;

/**
 * Назначение на оценку проекта глазами администратора.
 *
 * Отдельно от `ExpertAssignmentSchema`: та — взгляд эксперта на СВОИ
 * назначения и говорит о проекте. Здесь наоборот — взгляд на проект, и
 * называется эксперт.
 */
export const ProjectReviewAssignmentSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  expertId: UuidSchema,
  expertName: z.string(),
  /**
   * Состояние РАБОТЫ. Прекращение доступа его не переписывает: сданная
   * рецензия остаётся сданной (M120).
   */
  status: z.enum(['assigned', 'accepted', 'declined', 'completed', 'expired']),
  dueAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  /** Подана ли рецензия. Прекращение доступа её не удаляет и не обезличивает. */
  reviewSubmitted: z.boolean(),
  /**
   * Момент прекращения доступа по этому назначению — отдельный от работы факт.
   * `null` означает, что доступ по назначению открыт.
   */
  accessRevokedAt: IsoDateTimeSchema.nullable(),
});
export type ProjectReviewAssignment = z.infer<typeof ProjectReviewAssignmentSchema>;

/**
 * Прекращение доступа по назначению.
 *
 * Именно доступа, а не работы: рецензия, её авторство и история назначения
 * остаются. Основание обязательно — это решение человека, и оно попадает в
 * журнал вместе с тем, кто его принял.
 */
export const RevokeAssignmentAccessRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type RevokeAssignmentAccessRequest = z.infer<typeof RevokeAssignmentAccessRequestSchema>;

// ------------------------------------------------------- ручные записи о деньгах

/**
 * Фиксация фактически состоявшегося возврата по траншу.
 *
 * Это ЗАПИСЬ О СОБЫТИИ, а не платёжная команда: платформа денег не
 * перечисляет. Возвраты бывают частичными; их сумма не превышает
 * подтверждённую сумму транша, а повторная отправка не создаёт дубликат.
 */
export const TrancheReturnSchema = z.object({
  id: UuidSchema,
  trancheId: UuidSchema,
  amount: z.string(),
  currency: PolicyCurrencySchema,
  occurredOn: z.string(),
  reason: z.string(),
  evidenceRef: z.string().nullable(),
  recordedBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
  cancelledAt: IsoDateTimeSchema.nullable(),
  cancelReason: z.string().nullable(),
});
export type TrancheReturn = z.infer<typeof TrancheReturnSchema>;

export const RecordTrancheReturnRequestSchema = z.object({
  trancheId: UuidSchema,
  amount: MoneyAmountSchema,
  currency: PolicyCurrencySchema,
  /** Дата фактического возврата, а не момента записи. */
  occurredOn: z.iso.date(),
  reason: z.string().trim().min(3).max(1000),
  /** Подтверждение, если оно есть: документ или банковский идентификатор. */
  evidenceRef: z.string().trim().min(3).max(200).optional(),
  idempotencyKey: z.string().trim().min(8).max(120),
});
export type RecordTrancheReturnRequest = z.infer<typeof RecordTrancheReturnRequestSchema>;

export const CancelTrancheReturnRequestSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});
export type CancelTrancheReturnRequest = z.infer<typeof CancelTrancheReturnRequestSchema>;

/**
 * Корректировка вознаграждения.
 *
 * `accrual_reduction` — уменьшено НАЧИСЛЕНИЕ; денег никто не возвращал.
 * `paid_refund` — фактически возвращены УЖЕ УПЛАЧЕННЫЕ деньги.
 * Одно из другого не следует, и автоматических перечислений нет.
 */
export const CommissionAdjustmentKindSchema = z.enum(['accrual_reduction', 'paid_refund']);

export const CommissionAdjustmentSchema = z.object({
  id: UuidSchema,
  accrualId: UuidSchema,
  kind: CommissionAdjustmentKindSchema,
  party: z.enum(['investor', 'issuer']),
  amount: z.string(),
  currency: PolicyCurrencySchema,
  reason: z.string(),
  recordedBy: UuidSchema,
  createdAt: IsoDateTimeSchema,
});
export type CommissionAdjustment = z.infer<typeof CommissionAdjustmentSchema>;

export const RecordCommissionAdjustmentRequestSchema = z.object({
  accrualId: UuidSchema,
  kind: CommissionAdjustmentKindSchema,
  party: z.enum(['investor', 'issuer']),
  amount: MoneyAmountSchema,
  currency: PolicyCurrencySchema,
  reason: z.string().trim().min(3).max(1000),
  idempotencyKey: z.string().trim().min(8).max(120),
});
export type RecordCommissionAdjustmentRequest = z.infer<
  typeof RecordCommissionAdjustmentRequestSchema
>;

/** Строка списка сделок для ручных записей. */
export const DealSummarySchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectTitle: z.string(),
  status: z.string(),
  contractAmount: z.string(),
  currency: PolicyCurrencySchema,
  confirmedTranches: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
});
export type DealSummary = z.infer<typeof DealSummarySchema>;

/** Денежная картина сделки: транши с возвратами и начисления с корректировками. */
export const DealLedgerSchema = z.object({
  agreementId: UuidSchema,
  projectId: UuidSchema,
  contractAmount: z.string(),
  currency: PolicyCurrencySchema,
  tranches: z.array(
    z.object({
      id: UuidSchema,
      trancheNo: z.number().int().positive(),
      amount: z.string(),
      status: z.string(),
      confirmedAt: IsoDateTimeSchema.nullable(),
      /** Сумма действующих записей о возврате по этому траншу. */
      returnedAmount: z.string(),
      returns: z.array(TrancheReturnSchema),
    }),
  ),
  accruals: z.array(
    z.object({
      id: UuidSchema,
      trancheId: UuidSchema,
      baseAmount: z.string(),
      totalPct: z.string(),
      investorFeeAmount: z.string(),
      issuerFeeAmount: z.string(),
      accruedAt: IsoDateTimeSchema,
      adjustments: z.array(CommissionAdjustmentSchema),
    }),
  ),
});
export type DealLedger = z.infer<typeof DealLedgerSchema>;
