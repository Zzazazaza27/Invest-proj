import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/primitives';

/**
 * Исполнение услуги по позиции покупки (этап 6.1; структуры — M111).
 *
 * Отвечает на вопрос, который раньше задать было некому: услуга оплачена — а
 * сделана ли она на самом деле? Для услуг, которые выполняет сотрудник,
 * ответом остаётся его отметка с основанием. Для услуг, которые выполняет
 * платформа (сегодня это ИИ-разбор заявки), ответом становится прогон:
 * запущен, идёт, завершился результатом или ошибкой.
 *
 * Три вещи, которые эта модель обязана говорить честно:
 *
 *  • **чем выполнено.** `engine` различает разбор с языковой моделью,
 *    эвристический разбор без неё и тестовое исполнение. Называть тестовую
 *    заглушку анализом нельзя;
 *  • **по какой версии.** Отчёт относится к состоянию заявки на момент
 *    прогона. Правка заявки после разбора не делает отчёт новым — она делает
 *    его отчётом о прошлой версии, и это видно;
 *  • **что отчёт НЕ означает.** Ни одобрения проекта, ни допуска раунда:
 *    и то и другое решается отдельно и другими правилами.
 */

export const ServiceRunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type ServiceRunStatus = z.infer<typeof ServiceRunStatusSchema>;

/**
 * Чем именно выполнен разбор.
 *
 * `llm` — с языковой моделью через шлюз; `heuristic` — расчёт по правилам без
 * модели (настоящая работа, но другого качества); `test` — проверочное
 * исполнение, результат которого анализом не является.
 */
export const ServiceRunEngineSchema = z.enum(['llm', 'heuristic', 'test']);
export type ServiceRunEngine = z.infer<typeof ServiceRunEngineSchema>;

export const ServiceRunViewSchema = z.object({
  id: z.uuid(),
  itemId: z.uuid(),
  purchaseId: z.uuid(),
  kind: z.literal('ai_analysis'),
  status: ServiceRunStatusSchema,
  engine: ServiceRunEngineSchema.nullable(),
  isTest: z.boolean(),

  /** Версия заявки, по которой сделан разбор. */
  inputVersionId: z.uuid().nullable(),
  inputVersionNo: z.number().int().nullable(),
  /** Отпечаток входа: по нему видно, что анализировалось ровно это. */
  inputSha256: z.string().nullable(),
  /**
   * Заявка изменилась после разбора. Отчёт от этого не исчезает и не
   * становится неверным — он остаётся отчётом о прошлой версии.
   */
  inputChangedSince: z.boolean(),

  /** Ссылка на результат (паспорт проекта), когда он сохранён. */
  resultRef: z.uuid().nullable(),
  errorMessage: z.string().nullable(),

  startedAt: IsoDateTimeSchema,
  finishedAt: IsoDateTimeSchema.nullable(),

  /** Человеческим языком: что сейчас происходит и что означает результат. */
  explanation: z.array(z.string()),
});
export type ServiceRunView = z.infer<typeof ServiceRunViewSchema>;

/**
 * Почему запуск недоступен.
 *
 * Отдельный тип, потому что причин несколько и они разные по смыслу: покупка
 * не оплачена, услуга выполняется человеком, разбор уже сделан, контур ИИ не
 * настроен. Показывать вместо них одну серую кнопку — значит заставлять
 * основателя гадать.
 */
export const ServiceRunAvailabilitySchema = z.object({
  itemId: z.uuid(),
  canStart: z.boolean(),
  blocker: z.string().nullable(),
  run: ServiceRunViewSchema.nullable(),
});
export type ServiceRunAvailability = z.infer<typeof ServiceRunAvailabilitySchema>;
