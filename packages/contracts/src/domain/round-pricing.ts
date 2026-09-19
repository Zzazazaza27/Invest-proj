import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/primitives';
import { ServiceCountryCodeSchema, PolicyCurrencySchema } from './service-country';

/**
 * Расчёт стоимости запуска раунда (этап 5.9.2; предложение — M095).
 *
 * ОДНО место, где считается, во что обходится запуск конкретного раунда.
 * Три маршрута (открытие, возобновление, увеличение суммы) спрашивают его, а
 * не считают сами: иначе любой из них стал бы обходом оплаты.
 *
 * Что расчёт делает:
 *
 *  • по стране и сумме запроса находит ТРЕБУЕМЫЙ пакет — диапазоны в стране
 *    не пересекаются (M095), поэтому он ровно один или его нет;
 *  • принимает выбор основателя: более полный пакет и докупаемые услуги;
 *  • складывает итог в одной валюте и объясняет словами, из чего он вышел.
 *
 * Чего расчёт НЕ делает: не применяет бесплатную границу (её база не
 * определена — реестр решений), не считает зачёт услуг в комиссию и не
 * выдумывает доплату при изменении раунда. Пока эти правила не заданы
 * владельцем, соответствующая настройка означает отказ (fail-closed), а не
 * молчаливое «бесплатно».
 */

const OfferCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,40}$/, 'код: латиница, цифры и подчёркивание, 3–41 символ');

/**
 * Режим расчёта.
 *
 * `free` — платные пакеты выключены условиями страны: запуск бесплатен, и
 * это единственный режим, при котором действие сейчас проходит.
 * `priced` — стоимость посчитана; оплата ещё не реализована, поэтому само
 * действие всё равно не пропускается.
 * `blocked` — посчитать нельзя: настройка включена, но правило не задано,
 * либо сетка не покрывает сумму. Отказ с причиной, не «бесплатно».
 */
export const RoundQuoteModeSchema = z.enum(['free', 'priced', 'blocked']);
export type RoundQuoteMode = z.infer<typeof RoundQuoteModeSchema>;

/** Пакет в расчёте: то, что человек должен увидеть, без служебных полей. */
export const RoundQuotePackageSchema = z.object({
  code: OfferCodeSchema,
  version: z.number().int().positive(),
  name: z.string(),
  price: z.string(),
  currency: PolicyCurrencySchema,
  minTarget: z.string(),
  maxTarget: z.string().nullable(),
  services: z.array(z.object({ code: OfferCodeSchema, name: z.string() })),
  /**
   * Чем администратор РАЗРЕШИЛ заменить этот пакет. Список явный: ни цена, ни
   * совпадение состава альтернативой не делают (решение владельца
   * 2026-09-19). Пусто — замен нет, берётся требуемый.
   */
  allowedAlternatives: z.array(OfferCodeSchema).default([]),
});
export type RoundQuotePackage = z.infer<typeof RoundQuotePackageSchema>;

/**
 * Строка счёта. `role` говорит, ПОЧЕМУ позиция здесь: обязательный пакет,
 * выбранный основателем более полный пакет или докупленная услуга. Без этого
 * итог пришлось бы объяснять задним числом.
 */
export const RoundQuoteLineSchema = z.object({
  kind: z.enum(['package', 'service']),
  role: z.enum(['required_package', 'chosen_package', 'extra_service']),
  code: OfferCodeSchema,
  title: z.string(),
  amount: z.string(),
  currency: PolicyCurrencySchema,
});
export type RoundQuoteLine = z.infer<typeof RoundQuoteLineSchema>;

export const RoundQuoteSchema = z.object({
  mode: RoundQuoteModeSchema,
  countryCode: ServiceCountryCodeSchema,
  /** Версия условий страны, по которой считали: расчёт воспроизводим. */
  policyVersion: z.number().int().positive(),
  /** Сумма запроса, по которой подбирался пакет; `null` — ещё не задана. */
  target: z.string().nullable(),
  currency: PolicyCurrencySchema,
  /** Пакет по диапазону суммы. `null` — сетка не покрывает сумму. */
  requiredPackage: RoundQuotePackageSchema.nullable(),
  /**
   * Что выбрано вместо требуемого. `null` — берётся требуемый.
   *
   * Заменить требуемый пакет можно только тем, что администратор назначил
   * допустимой альтернативой ЯВНО (решение владельца 2026-09-19). Ни цена, ни
   * совпадение состава заменой не делают; проверка состава осталась
   * предупреждением администратору при настройке.
   */
  chosenPackage: RoundQuotePackageSchema.nullable(),
  /** Докупленные услуги сверх состава пакета. */
  extraServices: z.array(
    z.object({
      code: OfferCodeSchema,
      name: z.string(),
      price: z.string(),
      currency: PolicyCurrencySchema,
    }),
  ),
  lines: z.array(RoundQuoteLineSchema),
  total: z.string(),
  /** Почему посчитать нельзя. Пусто, если `mode` не `blocked`. */
  blockers: z.array(z.object({ path: z.string(), message: z.string() })),
  /** Объяснение для человека: по строке на факт, в порядке появления. */
  explanation: z.array(z.string()),
});
export type RoundQuote = z.infer<typeof RoundQuoteSchema>;

/** Выбор основателя. Пустой — считаем по требуемому пакету. */
export const RoundQuoteSelectionSchema = z.object({
  packageCode: OfferCodeSchema.optional(),
  serviceCodes: z.array(OfferCodeSchema).max(30).default([]),
});
export type RoundQuoteSelection = z.infer<typeof RoundQuoteSelectionSchema>;

// --------------------------------------------------------------------- расчёт

/** Действующее предложение страны на момент расчёта. */
export interface RoundOffering {
  packages: RoundQuotePackage[];
  /** Цены докупаемых услуг: только те, у которых есть действующая версия. */
  serviceOffers: { code: string; name: string; price: string; currency: string }[];
}

export interface RoundQuoteInput {
  countryCode: string;
  policyVersion: number;
  /** Условия страны: включатели решают режим, а не суммы. */
  policy: { paidPackagesEnabled: boolean; freeAttractionEnabled: boolean; baseCurrency: string };
  /** Сумма запроса раунда; `null` — ещё не задана. */
  target: string | null;
  /** Валюта раунда; `null` — берётся базовая валюта страны. */
  currency: string | null;
  selection: RoundQuoteSelection;
  offering: RoundOffering;
}

/**
 * Единственное место, где считается стоимость запуска раунда.
 *
 * Порядок решений намеренно такой: сначала «а платим ли вообще», затем «что
 * требуется», затем «что выбрано сверх». Из-за этого выключенные платные
 * пакеты дают бесплатный запуск независимо от состояния сетки, а включённые,
 * но не покрытые сеткой суммы дают отказ с причиной, а не ноль.
 */
export function computeRoundQuote(input: RoundQuoteInput): RoundQuote {
  const currency = (input.currency ?? input.policy.baseCurrency) as RoundQuote['currency'];
  const base = {
    countryCode: input.countryCode as RoundQuote['countryCode'],
    policyVersion: input.policyVersion,
    target: input.target,
    currency,
  };
  const explanation: string[] = [];
  const blockers: { path: string; message: string }[] = [];

  // Бесплатная граница включена, но её база не определена (реестр решений).
  // Считать «бесплатно» было бы догадкой о деньгах, поэтому отказ.
  if (input.policy.freeAttractionEnabled) {
    blockers.push({
      path: 'serviceCountry',
      message:
        `бесплатная граница включена в условиях страны (версия ${input.policyVersion}), ` +
        'но база её учёта не определена: расчёт недоступен',
    });
    return {
      ...base,
      mode: 'blocked',
      requiredPackage: null,
      chosenPackage: null,
      extraServices: [],
      lines: [],
      total: '0.00',
      blockers,
      explanation: [
        'Стоимость не рассчитана: включена бесплатная граница, правило её учёта ещё не задано.',
      ],
    };
  }

  const required =
    input.target === null ? null : matchPackage(input.offering.packages, input.target);

  if (!input.policy.paidPackagesEnabled) {
    explanation.push('Запуск раунда сейчас бесплатен: платные пакеты выключены в условиях страны.');
    if (required) {
      explanation.push(
        `По действующей сетке сумме ${input.target} соответствовал бы пакет «${required.name}» ` +
          `(${required.price} ${required.currency}). Сейчас он не оплачивается.`,
      );
    }
    return {
      ...base,
      mode: 'free',
      requiredPackage: required,
      chosenPackage: null,
      extraServices: [],
      lines: [],
      total: '0.00',
      blockers: [],
      explanation,
    };
  }

  // Дальше — платный режим. Всё, чего не хватает для точного счёта, это отказ
  // с причиной: посчитать «примерно» деньги нельзя.
  if (input.target === null) {
    blockers.push({ path: 'target', message: 'сумма запроса не задана: пакет не определить' });
  } else if (!required) {
    blockers.push({
      path: 'target',
      message: `сетка пакетов страны не покрывает сумму ${input.target}`,
    });
  }
  if (required && required.currency !== currency) {
    blockers.push({
      path: 'currency',
      message: `пакет «${required.code}» продаётся в ${required.currency}, а раунд ведётся в ${currency}`,
    });
  }

  let chosen: RoundQuotePackage | null = null;
  // Выбор того же пакета — подтверждение, а не улучшение: считаем как есть.
  if (input.selection.packageCode && required && input.selection.packageCode !== required.code) {
    const candidate = input.offering.packages.find((p) => p.code === input.selection.packageCode);
    if (!candidate) {
      blockers.push({
        path: 'packageCode',
        message: `пакет «${input.selection.packageCode}» не продаётся сейчас`,
      });
    } else {
      // Замена допустима, только если администратор назвал её явно. Ни цена,
      // ни совпадение состава пакет заменой не делают: это продуктовое
      // решение, а не вычисление (решение владельца 2026-09-19).
      if (!required.allowedAlternatives.includes(candidate.code)) {
        blockers.push({
          path: 'packageCode',
          message:
            `пакет «${candidate.name}» не назначен допустимой заменой для требуемого ` +
            `«${required.name}»`,
        });
      } else if (candidate.currency !== currency) {
        blockers.push({
          path: 'packageCode',
          message: `пакет «${candidate.code}» продаётся в ${candidate.currency}, а раунд ведётся в ${currency}`,
        });
      } else {
        chosen = candidate;
      }
    }
  }

  const effective = chosen ?? required;
  const included = new Map((effective?.services ?? []).map((s) => [s.code, s.name]));

  const extras: RoundQuote['extraServices'] = [];
  for (const code of input.selection.serviceCodes) {
    const alreadyIncluded = included.get(code);
    if (alreadyIncluded !== undefined) {
      blockers.push({
        path: 'serviceCodes',
        message: `услуга «${alreadyIncluded}» уже входит в пакет: отдельно она не оплачивается`,
      });
      continue;
    }
    const offer = input.offering.serviceOffers.find((o) => o.code === code);
    if (!offer) {
      blockers.push({
        path: 'serviceCodes',
        message: `у услуги «${code}» нет действующей цены в этой стране: докупить нельзя`,
      });
      continue;
    }
    if (offer.currency !== currency) {
      blockers.push({
        path: 'serviceCodes',
        message: `услуга «${offer.code}» продаётся в ${offer.currency}, а раунд ведётся в ${currency}`,
      });
      continue;
    }
    extras.push({
      code: offer.code,
      name: offer.name,
      price: offer.price,
      currency: offer.currency as RoundQuote['currency'],
    });
  }

  if (blockers.length > 0) {
    return {
      ...base,
      mode: 'blocked',
      requiredPackage: required,
      chosenPackage: chosen,
      extraServices: extras,
      lines: [],
      total: '0.00',
      blockers,
      explanation: ['Стоимость не рассчитана: ' + blockers.map((b) => b.message).join('; ') + '.'],
    };
  }

  const lines: RoundQuoteLine[] = [];
  let totalMinor = 0n;
  if (effective) {
    lines.push({
      kind: 'package',
      role: chosen ? 'chosen_package' : 'required_package',
      code: effective.code,
      title: effective.name,
      amount: effective.price,
      currency,
    });
    totalMinor += minorUnits(effective.price);
  }
  for (const extra of extras) {
    lines.push({
      kind: 'service',
      role: 'extra_service',
      code: extra.code,
      title: extra.name,
      amount: extra.price,
      currency,
    });
    totalMinor += minorUnits(extra.price);
  }

  if (required) {
    explanation.push(
      `Сумме запроса ${input.target} ${currency} соответствует пакет «${required.name}» ` +
        `(${required.price} ${currency}).`,
    );
  }
  if (chosen && required) {
    explanation.push(
      `Выбран пакет «${chosen.name}» (${chosen.price} ${currency}) — допустимая замена ` +
        `требуемого «${required.name}», назначенная администратором.`,
    );
  }
  if (extras.length > 0) {
    explanation.push(
      `Докуплено сверх пакета: ${extras
        .map((e) => `${e.name} (${e.price} ${currency})`)
        .join(', ')}.`,
    );
  }
  explanation.push(`Итого: ${fromMinor(totalMinor)} ${currency}.`);

  return {
    ...base,
    mode: 'priced',
    requiredPackage: required,
    chosenPackage: chosen,
    extraServices: extras,
    lines,
    total: fromMinor(totalMinor),
    blockers: [],
    explanation,
  };
}

/**
 * Подбор пакета по сумме: диапазон `[minTarget, maxTarget)`, верхняя граница
 * `null` — «и выше». Диапазоны внутри страны не пересекаются (M095), поэтому
 * совпадение ровно одно; если их вдруг больше, расчёт не выбирает «первый
 * попавшийся», а возвращает `null` — пусть лучше будет отказ, чем случайная
 * цена.
 */
function matchPackage(packages: RoundQuotePackage[], target: string): RoundQuotePackage | null {
  const amount = minorUnits(target);
  const matched = packages.filter((p) => {
    const from = minorUnits(p.minTarget);
    const to = p.maxTarget === null ? null : minorUnits(p.maxTarget);
    return amount >= from && (to === null || amount < to);
  });
  return matched.length === 1 ? matched[0]! : null;
}

/** Копейки целым: деньги здесь не проходят через плавающую точку. */
function minorUnits(amount: string): bigint {
  const [whole = '0', fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2));
}

function fromMinor(minor: bigint): string {
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
}

// ------------------------------------------------------------- покупка

/**
 * Покупка запуска раунда для экрана (5.9.7).
 *
 * `openBlocker` — что мешает открыть раунд прямо сейчас: покупки нет, не
 * оплачена или услуги не выполнены. `null` — препятствий нет. Держать это в
 * одном поле честнее, чем заставлять интерфейс выводить причину самому.
 */
export const RoundPurchaseViewSchema = z.object({
  id: z.uuid(),
  roundId: z.uuid(),
  projectId: z.uuid(),
  status: z.enum(['pending_payment', 'paid', 'cancelled', 'refunded']),
  totalAmount: z.string(),
  currency: PolicyCurrencySchema,
  /** Оплата подтверждена ТЕСТОВЫМ действием, а не деньгами. */
  isTestPayment: z.boolean(),
  /** Срок действия покупки в днях; 0 — без ограничения. */
  validityDays: z.number().int().nonnegative(),
  createdAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
  packageCode: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(['package', 'service']),
      serviceCode: z.string().nullable(),
      title: z.string(),
      amount: z.string(),
      currency: PolicyCurrencySchema,
      /** Состояние работы по этой покупке; ставится человеком с основанием. */
      fulfillmentStatus: z.enum(['planned', 'in_progress', 'fulfilled', 'not_fulfilled']),
      fulfillmentNote: z.string().nullable(),
      fulfilledAt: IsoDateTimeSchema.nullable(),
    }),
  ),
  openBlocker: z.string().nullable(),
});
export type RoundPurchaseView = z.infer<typeof RoundPurchaseViewSchema>;

export const SetItemFulfillmentRequestSchema = z.object({
  status: z.enum(['planned', 'in_progress', 'fulfilled', 'not_fulfilled']),
  /** Основание обязательно: «выполнено» без объяснения — это не отчёт. */
  note: z.string().trim().min(3).max(1000),
});
export type SetItemFulfillmentRequest = z.infer<typeof SetItemFulfillmentRequestSchema>;
