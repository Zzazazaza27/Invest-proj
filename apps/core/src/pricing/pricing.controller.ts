import { Controller, Get } from '@nestjs/common';
import { PricingSchema, type Pricing } from '@unicorn/contracts';
import { Public } from '../auth/guards';
import { Database } from '../db/unit-of-work';
import { errors } from '../common/errors';

/**
 * Публичная витрина цен.
 *
 * Доступна БЕЗ авторизации — это продуктовый принцип радикальной прозрачности
 * (Architect_Launch §5.4), а не удобство. Вместе с тарифами отдаётся раскрытие
 * условий вознаграждения: база — полная сумма договора, начисление однократное.
 * Фронтенд обязан показать это до регистрации.
 */
@Controller()
export class PricingController {
  constructor(private readonly db: Database) {}

  @Public()
  @Get('pricing')
  async pricing(): Promise<Pricing> {
    const anonymous = { userId: null, roles: [], traceId: 'pricing' };

    return this.db.readOnly(anonymous, async (tx) => {
      const plans = await tx.query(
        `SELECT id, code, version, audience, name,
                ask_limit::text AS ask_limit, individual_pricing,
                price::text AS price, currency, billing_period,
                valid_from, valid_to
           FROM billing.subscription_plans
          WHERE valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          ORDER BY audience, ask_limit NULLS LAST`,
      );

      // Объявленные, но ещё не вступившие в силу версии. Пользователь должен
      // узнавать о повышении цены заранее, а не из первого списания.
      const announced = await tx.query(
        `SELECT id, code, version, audience, name,
                ask_limit::text AS ask_limit, individual_pricing,
                price::text AS price, currency, billing_period,
                valid_from, valid_to
           FROM billing.subscription_plans
          WHERE valid_from > now()
          ORDER BY valid_from, audience`,
      );

      const fee = await tx.query(
        `SELECT id, code, version,
                investor_fee_pct::text AS investor_fee_pct,
                issuer_fee_pct::text AS issuer_fee_pct,
                rules_version, valid_from, valid_to
           FROM billing.fee_schedules
          WHERE code = 'operator_success_fee'
            AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
          ORDER BY version DESC LIMIT 1`,
      );

      const feeRow = fee.rows[0];
      if (!feeRow) {
        // Показать тарифы без условий вознаграждения нельзя: это и есть
        // нарушение обязательного раскрытия.
        throw errors.internal({ reason: 'active fee schedule not found' });
      }

      return PricingSchema.parse({
        plans: plans.rows.map(mapPlan),
        announcedPlans: announced.rows.map(mapPlan),
        feeSchedule: mapFee(feeRow),
        feeDisclosure: {
          baseIsFullContractAmount: true,
          accrualIsOneTime: true,
          triggerDescription:
            'Вознаграждение оператора начисляется один раз: после подписания договора ' +
            'обеими сторонами и подтверждения первого транша через номинальный счёт. ' +
            'База — полная сумма договора, а не размер транша. Последующие транши ' +
            'нового начисления не создают и уже возникшее обязательство не уменьшают.',
        },
      });
    });
  }
}

interface PlanRow {
  id: string;
  code: string;
  version: number;
  audience: string;
  name: string;
  ask_limit: string | null;
  individual_pricing: boolean;
  price: string | null;
  currency: string;
  billing_period: string;
  valid_from: Date;
  valid_to: Date | null;
}

function mapPlan(row: unknown) {
  const r = row as PlanRow;
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    audience: r.audience,
    name: r.name,
    askLimit: r.ask_limit,
    individualPricing: r.individual_pricing,
    price: r.price,
    currency: r.currency,
    billingPeriod: r.billing_period,
    validFrom: r.valid_from.toISOString(),
    validTo: r.valid_to?.toISOString() ?? null,
  };
}

interface FeeRow {
  id: string;
  code: string;
  version: number;
  investor_fee_pct: string;
  issuer_fee_pct: string;
  rules_version: string;
  valid_from: Date;
  valid_to: Date | null;
}

function mapFee(row: unknown) {
  const r = row as FeeRow;
  return {
    id: r.id,
    code: r.code,
    version: r.version,
    investorFeePct: r.investor_fee_pct,
    issuerFeePct: r.issuer_fee_pct,
    rulesVersion: r.rules_version,
    validFrom: r.valid_from.toISOString(),
    validTo: r.valid_to?.toISOString() ?? null,
  };
}
