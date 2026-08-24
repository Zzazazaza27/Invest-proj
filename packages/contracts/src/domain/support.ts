import { z } from 'zod';
import { boundedString, IsoDateTimeSchema, UuidSchema } from '../common/primitives';

/**
 * Поддержка и сообщения об ошибках.
 *
 * Одна сущность на две задачи — их различает `kind`:
 *  * `support`    — обращение в поддержку, человек пишет сам;
 *  * `bug_report` — сообщение об ошибке из служебной формы тестировщика, к
 *                   которому клиент прикладывает технический контекст.
 *
 * Жизненный цикл у них общий: пришло → взяли в работу → ответили → закрыли.
 */

export const SupportTicketKindSchema = z.enum(['support', 'bug_report']);
export type SupportTicketKind = z.infer<typeof SupportTicketKindSchema>;

export const SupportTicketStatusSchema = z.enum(['new', 'in_progress', 'closed']);
export type SupportTicketStatus = z.infer<typeof SupportTicketStatusSchema>;

/**
 * Технический контекст, который клиент СМЕЕТ прислать.
 *
 * Это разрешённый список, а не «удобная форма для произвольного JSON», и в
 * этом весь смысл: страница знает про себя гораздо больше, чем следует
 * пересылать. Пароля, access/refresh-токена, cookie авторизации и любых иных
 * секретов здесь нет — полей под них не существует, а неизвестные поля
 * отвергаются проверкой на границе сервера (`parseOrThrow` делает схему
 * строгой рекурсивно).
 *
 * Чего клиент НЕ присылает, хотя оно попадёт в обращение: идентификатор
 * пользователя, его роль, момент обращения, browser user agent и
 * trace/correlation ID. Всё это сервер берёт из контекста запроса — иначе
 * значения были бы утверждениями клиента о самом себе, а в баг-репорте нужен
 * факт.
 */
export const BugContextSchema = z.object({
  /** Адрес страницы, на которой человек был. Без фрагмента: там ходят токены из писем. */
  url: boundedString(0, 2000).optional(),
  /** Версия приложения или commit hash, если сборка их знает. */
  appVersion: boundedString(0, 100).optional(),
  /** Размер окна: «1440x900». Половина визуальных дефектов воспроизводится только на нём. */
  viewport: z
    .string()
    .regex(/^\d{1,5}x\d{1,5}$/, 'ожидается «ширинаxвысота», например 1440x900')
    .optional(),
  /** Язык интерфейса браузера. */
  locale: boundedString(0, 35).optional(),
});
export type BugContext = z.infer<typeof BugContextSchema>;

export const CreateSupportTicketRequestSchema = z.object({
  kind: SupportTicketKindSchema,
  subject: boundedString(3, 200),
  body: boundedString(1, 5000),
  /** Есть смысл только у `bug_report`; у обращения в поддержку игнорируется. */
  context: BugContextSchema.optional(),
});
export type CreateSupportTicketRequest = z.infer<typeof CreateSupportTicketRequestSchema>;

export const AddSupportMessageRequestSchema = z.object({
  body: boundedString(1, 5000),
});
export type AddSupportMessageRequest = z.infer<typeof AddSupportMessageRequestSchema>;

/**
 * Смена состояния рассмотрения. Доступна только сотруднику поддержки.
 *
 * `assignToMe` отдельным флагом, а не идентификатором исполнителя в теле:
 * назначить обращение на ДРУГОГО человека — другая операция с другими
 * правами, и принимать чужой userId из запроса ради неё значило бы открыть
 * его подмену раньше, чем появится сама операция.
 */
export const UpdateSupportTicketRequestSchema = z.object({
  status: SupportTicketStatusSchema.optional(),
  assignToMe: z.boolean().optional(),
});
export type UpdateSupportTicketRequest = z.infer<typeof UpdateSupportTicketRequestSchema>;

export const SupportMessageSchema = z.object({
  id: UuidSchema,
  /** Кто написал в рамках обращения: сам человек или сотрудник поддержки. */
  authorKind: z.enum(['user', 'staff']),
  body: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type SupportMessage = z.infer<typeof SupportMessageSchema>;

export const SupportTicketSchema = z.object({
  id: UuidSchema,
  kind: SupportTicketKindSchema,
  subject: z.string(),
  status: SupportTicketStatusSchema,
  createdAt: IsoDateTimeSchema,
  closedAt: IsoDateTimeSchema.nullable(),
  /**
   * Момент последнего сообщения. Не хранится колонкой, а считается из
   * переписки: колонку пришлось бы обновлять при каждом сообщении, то есть
   * выдать автору право UPDATE на строку со статусом и назначением.
   */
  lastMessageAt: IsoDateTimeSchema.nullable(),
  messageCount: z.number().int().nonnegative(),
  /** Взято ли обращение в работу и кем — наружу отдаётся только факт, не человек. */
  assigned: z.boolean(),
});
export type SupportTicket = z.infer<typeof SupportTicketSchema>;

export const SupportTicketDetailSchema = SupportTicketSchema.extend({
  /** Технический контекст баг-репорта. У обращения в поддержку — пустой объект. */
  context: z.record(z.string(), z.unknown()),
  messages: z.array(SupportMessageSchema),
});
export type SupportTicketDetail = z.infer<typeof SupportTicketDetailSchema>;
