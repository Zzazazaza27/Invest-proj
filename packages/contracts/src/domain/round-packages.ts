import { z } from 'zod';
import { IsoDateTimeSchema, MoneyAmountSchema, UuidSchema } from '../common/primitives';
import { ServiceCountryCodeSchema, PolicyCurrencySchema } from './service-country';

/**
 * Разовая оплата запуска раунда (этап 5.9.1; таблицы M095).
 *
 * Основатель платит за запуск КОНКРЕТНОГО раунда, а не за подписку: размер
 * запроса определяет подходящий пакет по настраиваемой сетке, в пакет входят
 * услуги, недостающие докупаются, более полный пакет можно выбрать самому.
 *
 * Здесь только настройка предложения и снимок покупки. Расчёт стоимости и
 * оплата — отдельные шаги; продажи остаются выключенными, пока условия страны
 * держат `paidPackages.enabled` в нуле.
 */

/** Код услуги/пакета: имя для настройки, а не текст для человека. */
const OfferCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{2,40}$/, 'код: латиница, цифры и подчёркивание, 3–41 символ');

/**
 * Деньги сетки: ноль допустим, в отличие от `MoneyAmountSchema`. Нижняя
 * граница диапазона начинается с нуля, а бесплатный пакет — законная
 * настройка, а не ошибка ввода.
 */
const GridAmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'сумма: до 12 цифр целой части и не более 2 знаков после точки');

export const RoundServiceSchema = z.object({
  id: UuidSchema,
  code: OfferCodeSchema,
  name: z.string(),
  description: z.string().nullable(),
  /**
   * Услуга существует в продукте. Невыполнимую услугу нельзя ни включить в
   * пакет, ни продать отдельно — иначе настройка создавала бы обещание.
   */
  isImplemented: z.boolean(),
  /**
   * Кто выполняет услугу.
   *
   * `manual` — сотрудник платформы, и отметку «выполнено» ставит он, с
   * основанием. `ai_analysis` — платформа, и тогда отметка появляется ТОЛЬКО
   * после успешного разбора с сохранённым результатом: продавать разбор и
   * закрывать его галочкой нельзя.
   */
  executionKind: z.enum(['manual', 'ai_analysis']),
  createdAt: IsoDateTimeSchema,
});
export type RoundService = z.infer<typeof RoundServiceSchema>;

export const CreateRoundServiceRequestSchema = z.object({
  code: OfferCodeSchema,
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).optional(),
  executionKind: z.enum(['manual', 'ai_analysis']).optional(),
});
export type CreateRoundServiceRequest = z.infer<typeof CreateRoundServiceRequestSchema>;

export const UpdateRoundServiceRequestSchema = z
  .object({
    name: z.string().trim().min(2).max(160).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    isImplemented: z.boolean().optional(),
    executionKind: z.enum(['manual', 'ai_analysis']).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.isImplemented !== undefined ||
      v.executionKind !== undefined,
    { message: 'нечего менять', path: ['name'] },
  );
export type UpdateRoundServiceRequest = z.infer<typeof UpdateRoundServiceRequestSchema>;

/** Версия предложения: цена, валюта, диапазон суммы запроса и состав. */
export const RoundPackageSchema = z.object({
  id: UuidSchema,
  code: OfferCodeSchema,
  version: z.number().int().positive(),
  countryCode: ServiceCountryCodeSchema,
  name: z.string(),
  description: z.string().nullable(),
  price: z.string(),
  currency: PolicyCurrencySchema,
  /** Диапазон суммы запроса: `[minTarget, maxTarget)`; `null` сверху — «и выше». */
  minTarget: z.string(),
  maxTarget: z.string().nullable(),
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
  /** Что входит в пакет — коды и названия услуг. */
  services: z.array(z.object({ code: OfferCodeSchema, name: z.string() })),
  /**
   * Чем администратор разрешил заменить этот пакет. Список явный: ни цена, ни
   * совпадение состава альтернативой не делают.
   */
  alternatives: z
    .array(
      z.object({
        code: OfferCodeSchema,
        name: z.string(),
        /**
         * Состав альтернативы покрывает состав требуемого пакета. Это
         * ПРЕДУПРЕЖДЕНИЕ администратору при настройке, а не условие допуска:
         * решение о замене принимает он.
         */
        coversComposition: z.boolean(),
      }),
    )
    .default([]),
  /** Срок действия покупки в днях; 0 — без ограничения. */
  validityDays: z.number().int().nonnegative().default(0),
  /** Версия уже действует или действовала: денежные условия заморожены. */
  isLocked: z.boolean(),
  /** Продаётся прямо сейчас. */
  isActive: z.boolean(),
  reason: z.string(),
});
export type RoundPackage = z.infer<typeof RoundPackageSchema>;

export const PublishRoundPackageRequestSchema = z
  .object({
    code: OfferCodeSchema,
    countryCode: ServiceCountryCodeSchema,
    name: z.string().trim().min(2).max(160),
    description: z.string().trim().max(2000).optional(),
    price: GridAmountSchema,
    currency: PolicyCurrencySchema,
    minTarget: GridAmountSchema,
    maxTarget: MoneyAmountSchema.nullable().optional(),
    /** Только реализованные услуги; сервер проверяет это ещё раз. */
    serviceCodes: z.array(OfferCodeSchema).max(30).default([]),
    validFrom: IsoDateTimeSchema.optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .refine(
    (v) =>
      v.maxTarget === null ||
      v.maxTarget === undefined ||
      Number(v.maxTarget) > Number(v.minTarget),
    {
      message: 'верхняя граница диапазона должна быть больше нижней',
      path: ['maxTarget'],
    },
  );
export type PublishRoundPackageRequest = z.infer<typeof PublishRoundPackageRequestSchema>;

export const CloseRoundPackageRequestSchema = z.object({
  validTo: IsoDateTimeSchema.optional(),
  reason: z.string().trim().min(3).max(500),
});
export type CloseRoundPackageRequest = z.infer<typeof CloseRoundPackageRequestSchema>;

/** Цена докупаемой услуги по стране — версиями, как у пакета. */
export const RoundServiceOfferSchema = z.object({
  id: UuidSchema,
  serviceCode: OfferCodeSchema,
  serviceName: z.string(),
  countryCode: ServiceCountryCodeSchema,
  version: z.number().int().positive(),
  price: z.string(),
  currency: PolicyCurrencySchema,
  validFrom: IsoDateTimeSchema,
  validTo: IsoDateTimeSchema.nullable(),
  isActive: z.boolean(),
  reason: z.string(),
});
export type RoundServiceOffer = z.infer<typeof RoundServiceOfferSchema>;

export const PublishRoundServiceOfferRequestSchema = z.object({
  serviceCode: OfferCodeSchema,
  countryCode: ServiceCountryCodeSchema,
  price: GridAmountSchema,
  currency: PolicyCurrencySchema,
  validFrom: IsoDateTimeSchema.optional(),
  reason: z.string().trim().min(3).max(500),
});
export type PublishRoundServiceOfferRequest = z.infer<typeof PublishRoundServiceOfferRequestSchema>;

/**
 * Снимок покупки. Позиции хранят денежную базу каждой: для общей цены пакета
 * отдельные прайсы включённых услуг уплаченной суммой не считаются — это
 * понадобится будущему зачёту услуг в комиссию.
 */
export const RoundPurchaseItemSchema = z.object({
  id: UuidSchema,
  kind: z.enum(['package', 'service']),
  serviceCode: OfferCodeSchema.nullable(),
  title: z.string(),
  amount: z.string(),
  currency: PolicyCurrencySchema,
});
export type RoundPurchaseItem = z.infer<typeof RoundPurchaseItemSchema>;

export const RoundPurchaseSchema = z.object({
  id: UuidSchema,
  roundId: UuidSchema,
  projectId: UuidSchema,
  countryCode: ServiceCountryCodeSchema,
  policyVersion: z.number().int().positive(),
  totalAmount: z.string(),
  currency: PolicyCurrencySchema,
  status: z.enum(['pending_payment', 'paid', 'cancelled', 'refunded']),
  items: z.array(RoundPurchaseItemSchema),
  createdAt: IsoDateTimeSchema,
  paidAt: IsoDateTimeSchema.nullable(),
});
export type RoundPurchase = z.infer<typeof RoundPurchaseSchema>;

/** Назначение допустимой альтернативы пакету (5.9.7). */
export const SetPackageAlternativeRequestSchema = z.object({
  packageId: UuidSchema,
  alternativeId: UuidSchema,
  reason: z.string().trim().min(3).max(500),
});
export type SetPackageAlternativeRequest = z.infer<typeof SetPackageAlternativeRequestSchema>;
