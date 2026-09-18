import { z } from 'zod';
import {
  boundedString,
  IsoDateTimeSchema,
  MoneyAmountSchema,
  UuidSchema,
} from '../common/primitives';

/**
 * Страна обслуживания и её условия (план 0.2 §0г.2 п.7; таблицы M081).
 *
 * Страна хранится за аккаунтом и выбирается явно; язык интерфейса — отдельно
 * и на условия не влияет. Условия — версионируемая политика: коммерческие
 * значения — данные, не код. Бесплатная граница не может быть включена без
 * суммы и базы учёта: база (по раунду или накопительно по проекту) ещё не
 * определена владельцем (реестр §0г.7), поэтому `basis: null` допустим
 * только при выключенной границе.
 */

export const ServiceCountryCodeSchema = z.string().regex(/^[a-z]{2}$/, 'код страны');

export const ServiceCountrySchema = z.object({
  code: ServiceCountryCodeSchema,
  isActive: z.boolean(),
  sortOrder: z.number().int(),
});
export type ServiceCountry = z.infer<typeof ServiceCountrySchema>;

export const PolicyCurrencySchema = z.string().regex(/^[A-Z]{3}$/, 'код валюты');

export const FreeAttractionBasisSchema = z.enum(['per_round', 'cumulative_project']);
export type FreeAttractionBasis = z.infer<typeof FreeAttractionBasisSchema>;

export const ServiceCountryPolicySchema = z
  .object({
    baseCurrency: PolicyCurrencySchema,
    allowedRoundCurrencies: z.array(PolicyCurrencySchema).min(1),
    freeAttraction: z.object({
      enabled: z.boolean(),
      amount: MoneyAmountSchema.nullable(),
      basis: FreeAttractionBasisSchema.nullable(),
    }),
    paidPackages: z.object({ enabled: z.boolean() }),
    limits: z.object({
      /** Потолок суммы одного раунда; null — выключен (по умолчанию). */
      maxTargetPerRound: MoneyAmountSchema.nullable(),
    }),
    operator: z.object({
      manualReviewRequired: z.boolean(),
      notify: z.object({
        enabled: z.boolean(),
        minTarget: MoneyAmountSchema.nullable(),
        recipients: z.array(z.string().email()).max(20),
      }),
    }),
    fx: z.object({ mode: z.enum(['none']) }),
  })
  .superRefine((policy, ctx) => {
    if (!policy.allowedRoundCurrencies.includes(policy.baseCurrency)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedRoundCurrencies'],
        message: 'базовая валюта должна быть среди разрешённых валют раундов',
      });
    }
    if (policy.freeAttraction.enabled) {
      if (policy.freeAttraction.amount === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['freeAttraction', 'amount'],
          message: 'бесплатная граница без суммы не включается',
        });
      }
      if (policy.freeAttraction.basis === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['freeAttraction', 'basis'],
          message: 'база учёта бесплатной границы не определена — включать нельзя',
        });
      }
    }
    if (policy.operator.notify.enabled && policy.operator.notify.recipients.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['operator', 'notify', 'recipients'],
        message: 'уведомления без получателей не включаются',
      });
    }
  });
export type ServiceCountryPolicy = z.infer<typeof ServiceCountryPolicySchema>;

export const ServiceCountryPolicyVersionSchema = z.object({
  id: UuidSchema,
  countryCode: ServiceCountryCodeSchema,
  version: z.number().int().positive(),
  config: ServiceCountryPolicySchema,
  isActive: z.boolean(),
  validFrom: IsoDateTimeSchema,
  createdBy: UuidSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  reason: z.string(),
});
export type ServiceCountryPolicyVersion = z.infer<typeof ServiceCountryPolicyVersionSchema>;

export const ActivateServiceCountryPolicyRequestSchema = z.object({
  config: ServiceCountryPolicySchema,
  reason: boundedString(3, 500),
});
export type ActivateServiceCountryPolicyRequest = z.infer<
  typeof ActivateServiceCountryPolicyRequestSchema
>;

export const UpdateServiceCountryRequestSchema = z.object({
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
});
export type UpdateServiceCountryRequest = z.infer<typeof UpdateServiceCountryRequestSchema>;
