import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/primitives';
import { PolicyCurrencySchema } from './service-country';

/**
 * Оплата услуг платформы через оператора онлайн-платежей (5.9.9; M108).
 *
 * Здесь описана ТОЧКА ПОДКЛЮЧЕНИЯ, а не интеграция с конкретным сервисом.
 * Провайдер и получатель ещё не выбраны, поэтому модель намеренно не знает
 * ни одного имени: у платежа есть `provider` как строка, `providerRef` как
 * идентификатор на стороне оператора и режим `test | live`.
 *
 * Что оплачивается здесь: пакеты запуска раунда, докупаемые услуги и подписки
 * инвестора. Чего здесь нет и не будет автоматически: переводы инвестора в
 * проект и оплата комиссии сторонами — это отдельный процесс (решение
 * владельца), и через оператора оплаты услуг он не направляется.
 *
 * Два правила, которые важнее всего остального:
 *
 *  • сумма и валюта берутся СЕРВЕРОМ из предмета оплаты, а не из запроса;
 *  • возврат пользователя со страницы оплаты НИЧЕГО не подтверждает. Деньги
 *    считаются поступившими только после проверяемого уведомления провайдера.
 */

/** Режим платежа. Принадлежит записи, а не настройке: см. M108. */
export const PaymentModeSchema = z.enum(['test', 'live']);
export type PaymentMode = z.infer<typeof PaymentModeSchema>;

/**
 * Состояние платежа.
 *
 * `pending` — создан, пользователь ещё не заплатил; `succeeded` — подтверждён
 * уведомлением; `failed` — оператор сообщил об отказе; `canceled` —
 * пользователь отказался. Возвраты (`refunded`) сейчас только фиксируются
 * записью: автоматических возвратов нет.
 */
export const PaymentStatusSchema = z.enum([
  'pending',
  'authorized',
  'succeeded',
  'failed',
  'canceled',
  'partially_refunded',
  'refunded',
  'chargeback',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/** Что именно оплачивается. Ровно одно из двух. */
export const PaymentSubjectSchema = z.enum(['round_purchase', 'invoice']);

export const PaymentViewSchema = z.object({
  id: z.uuid(),
  subject: PaymentSubjectSchema,
  subjectId: z.uuid(),
  amount: z.string(),
  currency: PolicyCurrencySchema,
  provider: z.string(),
  /** Идентификатор платежа на стороне оператора; до создания — null. */
  providerRef: z.string().nullable(),
  status: PaymentStatusSchema,
  mode: PaymentModeSchema,
  /**
   * Куда отправить пользователя платить. Пустой у уже завершённых платежей.
   * Переход по адресу оплату не подтверждает.
   */
  redirectUrl: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  confirmedAt: IsoDateTimeSchema.nullable(),
  /**
   * Прямым текстом для интерфейса: что значит текущее состояние и чего ждать.
   * Нужно, чтобы экран не выдумывал формулировок про деньги.
   */
  explanation: z.array(z.string()),
});
export type PaymentView = z.infer<typeof PaymentViewSchema>;

/**
 * Запрос на создание платежа.
 *
 * Суммы здесь нет намеренно: её назначает сервер по предмету оплаты. Клиент
 * сообщает только, что именно оплачивает и куда вернуть пользователя.
 */
export const StartPaymentRequestSchema = z.object({
  returnUrl: z.string().max(2000).optional(),
});
export type StartPaymentRequest = z.infer<typeof StartPaymentRequestSchema>;

/**
 * Разобранное уведомление оператора — то, что адаптер обязан извлечь из
 * любого формата, каким бы конкретный оператор ни оказался.
 *
 * Здесь описано СОДЕРЖАНИЕ уведомления, а не способ доверять ему. Как адаптер
 * убеждается, что сообщение прислал именно его оператор — подписью по сырому
 * телу, заголовком, взаимным TLS или обратным запросом за состоянием
 * платежа, — решает сам адаптер по правилам своего оператора. Единой схемы
 * подписи платформа не навязывает.
 *
 * `eventId` обязателен: по нему повторное уведомление распознаётся как повтор.
 * Но повтор — не единственный случай: оператор присылает и РАЗНЫЕ события об
 * одном платеже, и опоздавшие события по отменённым попыткам. Поэтому решение
 * принимается по состоянию платежа и покупки, а не только по этому полю.
 */
export const ProviderNotificationSchema = z.object({
  eventId: z.string().min(1).max(200),
  eventType: z.string().min(1).max(100),
  providerRef: z.string().min(1).max(200),
  outcome: z.enum(['succeeded', 'failed', 'canceled', 'pending']),
  // Необязательные поля приводятся к null сразу: дальше по коду не должно быть
  // разницы между «оператор не прислал поле» и «прислал пустым».
  amount: z
    .string()
    .nullish()
    .transform((v) => v ?? null),
  currency: PolicyCurrencySchema.nullish().transform((v) => v ?? null),
  failureReason: z
    .string()
    .max(500)
    .nullish()
    .transform((v) => v ?? null),
});
export type ProviderNotification = z.infer<typeof ProviderNotificationSchema>;

/** Состояние подключения оператора — для админского экрана. */
export const PaymentProviderStatusSchema = z.object({
  /** Код подключённого адаптера; `test` — встроенный тестовый. */
  provider: z.string(),
  mode: PaymentModeSchema,
  /** Настоящий приём платежей включён? Флаг `billing.payments.enabled`. */
  acceptingRealPayments: z.boolean(),
  /** Готов ли адаптер принимать уведомления (есть ли ключ проверки подписи). */
  notificationsVerifiable: z.boolean(),
  /** Человеческим языком: что сейчас произойдёт при попытке оплатить. */
  explanation: z.array(z.string()),
});
export type PaymentProviderStatus = z.infer<typeof PaymentProviderStatusSchema>;
