import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';

/**
 * Условия вознаграждения платформы и зачёт оплаченных услуг (5.9.3; M096).
 *
 * Ставка ОДНА и считается от одной базы; между сторонами она распределяется в
 * процентных пунктах, и доли обязаны складываться в общую ставку. Начисление
 * происходит с КАЖДОГО подтверждённого транша: база — сумма транша.
 *
 * Зачёт оплаченных услуг в вознаграждение — структура без расчёта: правило
 * владельцем не утверждено, поэтому версия правила выключена, а запись зачёта
 * запрещена в базе.
 */

/** Процент с двумя знаками: деньги не проходят через плавающую точку. */
const PercentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'процент: до трёх цифр целой части и не более двух знаков')
  .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'процент вне диапазона 0–100');

export const FeeTermsSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  version: z.number().int().positive(),
  /** Общая ставка от базы начисления. */
  totalPct: z.string(),
  /** Доля инвестора в процентных пунктах общей ставки. */
  investorFeePct: z.string(),
  /** Доля привлекающего в процентных пунктах общей ставки. */
  issuerFeePct: z.string(),
  rulesVersion: z.string(),
  reason: z.string(),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
  /** Версия действует сейчас. */
  isActive: z.boolean(),
  /** Версия уже действовала: денежные условия заморожены. */
  isLocked: z.boolean(),
});
export type FeeTerms = z.infer<typeof FeeTermsSchema>;

export const PublishFeeTermsRequestSchema = z
  .object({
    code: z.string().trim().min(3).max(60).default('operator_success_fee'),
    totalPct: PercentSchema,
    investorFeePct: PercentSchema,
    issuerFeePct: PercentSchema,
    rulesVersion: z.string().trim().min(1).max(40),
    validFrom: IsoDateTimeSchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (v) =>
      Math.round((Number(v.investorFeePct) + Number(v.issuerFeePct)) * 100) ===
      Math.round(Number(v.totalPct) * 100),
    {
      message: 'доли сторон должны складываться в общую ставку',
      path: ['totalPct'],
    },
  );
export type PublishFeeTermsRequest = z.infer<typeof PublishFeeTermsRequestSchema>;

/** Версия правила зачёта услуг. Включение — отдельное решение владельца. */
export const FeeOffsetRuleSchema = z.object({
  id: UuidSchema,
  version: z.number().int().positive(),
  isEnabled: z.boolean(),
  isActive: z.boolean(),
  reason: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type FeeOffsetRule = z.infer<typeof FeeOffsetRuleSchema>;

export const ActivateFeeOffsetRuleRequestSchema = z.object({
  /**
   * Включать зачёт нельзя, пока правило не задано: сервер откажет. Поле
   * оставлено, чтобы включение было явным действием, а не побочным эффектом.
   */
  isEnabled: z.boolean(),
  reason: z.string().trim().min(3).max(500),
});
export type ActivateFeeOffsetRuleRequest = z.infer<typeof ActivateFeeOffsetRuleRequestSchema>;
