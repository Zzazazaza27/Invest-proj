import { Injectable } from '@nestjs/common';
import {
  computeRoundQuote,
  type RoundOffering,
  type RoundQuote,
  type RoundQuotePackage,
  type RoundQuoteSelection,
  type ServiceCountryPolicy,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import type { Tx } from '../db/unit-of-work';

/**
 * Стоимость запуска раунда (этап 5.9.2; предложение — M095, правило расчёта —
 * `computeRoundQuote` в contracts).
 *
 * Сервис делает ровно две вещи: читает ДЕЙСТВУЮЩЕЕ предложение страны и
 * отдаёт его расчёту. Никаких правил цены здесь нет — иначе их стало бы два
 * места, и они разошлись бы.
 *
 * Продажи выключены: покупка не создаётся, счёт не выставляется, деньги не
 * списываются. Расчёт нужен, чтобы показать основателю, во что обойдётся
 * запуск, и чтобы коммерческий гейт отказывал с понятной причиной, а не
 * пропускал платное как бесплатное.
 */
@Injectable()
export class RoundPricingService {
  /** Что продаётся в стране прямо сейчас: версии пакетов и цены докупки. */
  async offering(tx: Tx, countryCode: string): Promise<RoundOffering> {
    const { rows: packages } = await tx.query<PackageRow>(
      `SELECT p.code, p.version, p.name, p.price::text AS price, p.currency,
              p.min_target::text AS min_target, p.max_target::text AS max_target,
              COALESCE(
                (SELECT jsonb_agg(jsonb_build_object('code', s.code, 'name', s.name) ORDER BY s.code)
                   FROM billing.round_package_services ps
                   JOIN billing.round_services s ON s.id = ps.service_id
                  WHERE ps.package_id = p.id),
                '[]'::jsonb) AS services,
              COALESCE(
                (SELECT jsonb_agg(alt.code ORDER BY alt.code)
                   FROM billing.round_package_alternatives a
                   JOIN billing.round_packages alt ON alt.id = a.alternative_id
                  WHERE a.package_id = p.id),
                '[]'::jsonb) AS allowed_alternatives
         FROM billing.round_packages p
        WHERE p.country_code = $1
          AND p.valid_from <= now()
          AND (p.valid_to IS NULL OR p.valid_to > now())
        ORDER BY p.min_target`,
      [countryCode],
    );
    const { rows: offers } = await tx.query<OfferRow>(
      `SELECT s.code, s.name, o.price::text AS price, o.currency
         FROM billing.round_service_offers o
         JOIN billing.round_services s ON s.id = o.service_id
        WHERE o.country_code = $1
          AND o.valid_from <= now()
          AND (o.valid_to IS NULL OR o.valid_to > now())
        ORDER BY s.code`,
      [countryCode],
    );
    return {
      packages: packages.map((row): RoundQuotePackage => ({
        code: row.code,
        version: row.version,
        name: row.name,
        price: row.price,
        currency: row.currency,
        minTarget: row.min_target,
        maxTarget: row.max_target,
        services: row.services,
        allowedAlternatives: row.allowed_alternatives,
      })),
      serviceOffers: offers.map((row) => ({
        code: row.code,
        name: row.name,
        price: row.price,
        currency: row.currency,
      })),
    };
  }

  async quote(
    tx: Tx,
    params: {
      countryCode: string;
      policy: { version: number; config: ServiceCountryPolicy };
      target: string | null;
      currency: string | null;
      selection: RoundQuoteSelection;
    },
  ): Promise<RoundQuote> {
    return computeRoundQuote({
      countryCode: params.countryCode,
      policyVersion: params.policy.version,
      policy: {
        paidPackagesEnabled: params.policy.config.paidPackages.enabled,
        freeAttractionEnabled: params.policy.config.freeAttraction.enabled,
        baseCurrency: params.policy.config.baseCurrency,
      },
      target: params.target,
      currency: params.currency,
      selection: params.selection,
      offering: await this.offering(tx, params.countryCode),
    });
  }
}

interface PackageRow {
  code: string;
  version: number;
  name: string;
  price: string;
  currency: string;
  min_target: string;
  max_target: string | null;
  services: { code: string; name: string }[];
  allowed_alternatives: string[];
}

interface OfferRow {
  code: string;
  name: string;
  price: string;
  currency: string;
}

/**
 * Коммерческий гейт трёх маршрутов: открытие, возобновление, увеличение суммы.
 *
 * Бесплатный режим проходит всегда. Платный проходит, только когда по этому
 * раунду нет препятствий по покупке: она оформлена, оплачена и услуги по ней
 * выполнены (`billing.round_purchase_blocker`). Невозможность посчитать —
 * отказ с причиной из расчёта (fail-closed).
 */
export function assertCommercialConditions(
  quote: RoundQuote,
  action: 'open' | 'resume' | 'increase',
  blocker: string | null = null,
): RoundQuote {
  if (quote.mode === 'free') return quote;
  // Платный режим: если препятствий по покупке нет, действие проходит.
  // Порядок проверок утверждён владельцем — готовность, оплата, услуги,
  // допуск: сюда приходит уже готовый ответ «что именно мешает».
  if (quote.mode === 'priced' && blocker === null) return quote;

  if (quote.mode === 'blocked') {
    throw errors.validation(
      quote.blockers.map((b) => ({
        path: b.path,
        message: `${b.message}: действие «${action}» недоступно`,
      })),
    );
  }

  const what = quote.chosenPackage ?? quote.requiredPackage;
  throw errors.validation([
    {
      path: 'purchase',
      message:
        `запуск раунда платный: ${what ? `пакет «${what.name}», ` : ''}` +
        `итого ${quote.total} ${quote.currency}` +
        (blocker ? `. ${blocker}` : '') +
        `. Действие «${action}» недоступно`,
    },
  ]);
}
