import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema, boundedString } from '../common/primitives';
import { RoleSchema, UserStatusSchema } from './identity';

/**
 * Раздел «Пользователи» административного кабинета (этап 6).
 *
 * Отделён от «Доступа» по смыслу: здесь работают с КОНКРЕТНЫМ человеком —
 * найти, открыть карточку, посмотреть его состояние и распорядиться учётной
 * записью. «Доступ» отвечает на другой вопрос: как устроены права платформы
 * вообще.
 *
 * Три ограничения модели, которые видны прямо в этих схемах и которые нельзя
 * обойти красивым интерфейсом:
 *
 *  1. **Контакты приходят масками.** Полное значение — отдельным запросом, под
 *     полномочием `identity.user_contacts.view` и с записью в журнал (M122).
 *  2. **Поиск по контакту — только точный.** Адрес и телефон зашифрованы;
 *     совпадение ищется по слепому индексу, а он знает лишь целое значение.
 *     Поиск «по части адреса» означал бы расшифровку всей таблицы.
 *  3. **Состояние аккаунта — одно поле `status`.** Второго признака
 *     блокировки не заводится: он стал бы вторым местом правды.
 */

/**
 * Откуда взялась запись.
 *
 * Не «тип аккаунта», который ставят руками и перестают ставить на второй
 * неделе, а факт создания: его указывает тот, кто создаёт запись. На права не
 * влияет — это признак для отбора и уборки.
 */
export const AccountOriginSchema = z.enum([
  'self_registration',
  'invite',
  'seed_demo',
  'seed_acceptance',
  'staff_check',
  'render_check',
  'load_test',
  // Участник тестовой сессии (M129). Отличается от `render_check`
  // намеренно: следы прогонов убирает `stand:clean-probes` по возрасту, а
  // участников — уборка ИХ сессии. Смешать значит однажды снести участников
  // чужого разбора вместе со случайным мусором.
  'test_session',
  'unknown',
]);
export type AccountOrigin = z.infer<typeof AccountOriginSchema>;

/**
 * Что показывать в списке.
 *
 * `real` — люди и служебные записи, то есть всё, кроме записей проверок;
 * `probes` — ровно записи проверок: следы прогонов и участники сессий;
 * `all` — без отбора.
 */
export const AdminUserOriginFilterSchema = z.enum(['all', 'real', 'probes']);
export type AdminUserOriginFilter = z.infer<typeof AdminUserOriginFilterSchema>;

/** Происхождения, которые уборка вправе удалять. Список один на всю платформу. */
/**
 * Происхождения, которые список пользователей прячет по умолчанию.
 *
 * Это записи ПРОВЕРОК: следы браузерных и нагрузочных прогонов и участники
 * тестовых сессий. Живыми людьми они не являются, и в списке, где ищут
 * конкретного человека, они шум.
 *
 * ВАЖНО: перечень отвечает только за ОТБОР В СПИСКЕ. Кто и чем убирается —
 * решают разные механизмы: следы прогонов убирает `stand:clean-probes` по
 * своему перечню, участников сессии — уборка их сессии. Добавление сюда
 * ничего не удаляет.
 */
export const PROBE_ORIGINS = ['render_check', 'load_test', 'test_session'] as const;

/** По какому полю ищем. Поле выбирается явно — «умный» поиск угадывает неверно. */
export const AdminUserSearchFieldSchema = z.enum(['name', 'email', 'phone', 'id']);
export type AdminUserSearchField = z.infer<typeof AdminUserSearchFieldSchema>;

/** Столбцы, по которым разрешена сортировка. Белый список, а не строка из запроса. */
export const AdminUserSortSchema = z.enum(['created_at', 'display_name', 'status']);
export type AdminUserSort = z.infer<typeof AdminUserSortSchema>;

export const AdminUserKycStatusSchema = z.enum([
  'none',
  'pending',
  'in_review',
  'approved',
  'rejected',
  'verification_pending',
]);
export type AdminUserKycStatus = z.infer<typeof AdminUserKycStatusSchema>;

export const ADMIN_USERS_PER_PAGE_DEFAULT = 25;
export const ADMIN_USERS_PER_PAGE_MAX = 100;

/**
 * Запрос страницы списка.
 *
 * Поиск, фильтры и сортировка выполняются в БД по всей выборке, а не по
 * загруженной странице: страничная фильтрация врёт человеку, показывая «ничего
 * не найдено» там, где найденное просто на другой странице.
 */
export const AdminUserListQuerySchema = z.object({
  field: AdminUserSearchFieldSchema.default('name'),
  /** Пустая строка — не поиск, а «покажи начало списка». */
  q: z.string().trim().max(254).default(''),
  role: RoleSchema.optional(),
  status: UserStatusSchema.optional(),
  kyc: AdminUserKycStatusSchema.optional(),
  /** Отбор по происхождению; по умолчанию скрываются следы прогонов. */
  origin: AdminUserOriginFilterSchema.default('real'),
  sort: AdminUserSortSchema.default('created_at'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  perPage: z.coerce
    .number()
    .int()
    .min(5)
    .max(ADMIN_USERS_PER_PAGE_MAX)
    .default(ADMIN_USERS_PER_PAGE_DEFAULT),
});
export type AdminUserListQuery = z.input<typeof AdminUserListQuerySchema>;

/** Строка таблицы. Ровно то, что нужно, чтобы узнать человека и открыть карточку. */
export const AdminUserRowSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  emailMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  roles: z.array(z.string()),
  status: UserStatusSchema,
  kycStatus: AdminUserKycStatusSchema,
  origin: AccountOriginSchema,
  createdAt: IsoDateTimeSchema,
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

export const AdminUserPageSchema = z.object({
  items: z.array(AdminUserRowSchema),
  /** Всего подходящих записей — без него постраничная навигация слепая. */
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  perPage: z.number().int().min(1),
});
export type AdminUserPage = z.infer<typeof AdminUserPageSchema>;

// ------------------------------------------------------------------ карточка

export const AdminUserRoleGrantSchema = z.object({
  role: z.string(),
  grantedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});

export const AdminUserKycRecordSchema = z.object({
  id: UuidSchema,
  kind: z.string(),
  status: z.string(),
  provider: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  decidedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const AdminUserProjectSchema = z.object({
  id: UuidSchema,
  title: z.string(),
  role: z.string(),
  listingStatus: z.string(),
});

export const AdminUserEntitySchema = z.object({
  id: UuidSchema,
  legalName: z.string(),
  jurisdiction: z.string(),
  registryStatus: z.string(),
});

export const AdminUserCapabilitySchema = z.object({
  capability: z.string(),
  title: z.string(),
  reason: z.string(),
  grantedAt: IsoDateTimeSchema,
});

export const AdminUserAssignmentSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  projectTitle: z.string(),
  purpose: z.string(),
  status: z.string(),
  accessRevokedAt: IsoDateTimeSchema.nullable(),
});

/**
 * Строка истории административных действий.
 *
 * `context` отдаётся только для событий, которые платформа пишет сама и чей
 * состав известен (причина блокировки, изменённое поле). Произвольный
 * `context_jsonb` наружу не уходит: в нём может оказаться что угодно, включая
 * персональные данные, и карточка стала бы обходным путём к ним.
 */
export const AdminUserHistoryEntrySchema = z.object({
  ts: IsoDateTimeSchema,
  verb: z.string(),
  actorId: UuidSchema.nullable(),
  actorName: z.string().nullable(),
  context: z.record(z.string(), z.unknown()).nullable(),
});

export const AdminUserCardSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  emailMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  primaryRole: z.string(),
  origin: AccountOriginSchema,
  roles: z.array(AdminUserRoleGrantSchema),
  status: UserStatusSchema,
  /** Причина последней смены состояния администратором; у блокировки обязательна. */
  statusReason: z.string().nullable(),
  statusChangedAt: IsoDateTimeSchema.nullable(),
  statusChangedBy: UuidSchema.nullable(),
  statusChangedByName: z.string().nullable(),
  locale: z.string(),
  serviceCountry: z.string().nullable(),
  currencyPref: z.string(),
  homeContour: z.string(),
  mfaEnabled: z.boolean(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  /** Рубеж сессий: всё, что выдано раньше, недействительно (M035). */
  sessionsValidFrom: IsoDateTimeSchema,
  kyc: z.array(AdminUserKycRecordSchema),
  projects: z.array(AdminUserProjectSchema),
  entities: z.array(AdminUserEntitySchema),
  capabilities: z.array(AdminUserCapabilitySchema),
  assignments: z.array(AdminUserAssignmentSchema),
  supportTickets: z.number().int().min(0),
  history: z.array(AdminUserHistoryEntrySchema),
  /** Может ли смотрящий раскрыть контакты (полномочие M122). */
  canRevealContacts: z.boolean(),
});
export type AdminUserCard = z.infer<typeof AdminUserCardSchema>;

/** Раскрытые контакты. Отдельный ответ — чтобы их нельзя было получить случайно. */
export const AdminUserContactsSchema = z.object({
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
export type AdminUserContacts = z.infer<typeof AdminUserContactsSchema>;

// -------------------------------------------------------------------- действия

/**
 * Смена состояния учётной записи.
 *
 * Передаётся ДЕЙСТВИЕ, а не желаемый статус. Разница не косметическая: снятие
 * блокировки не всегда означает `active` — человек без акцептов актуальных
 * версий документов возвращается в `pending_consents`, и решает это сервер по
 * тому же инварианту, что и активация. Клиент, присылающий статус, неизбежно
 * ошибся бы в этом месте.
 *
 * Удаления здесь нет: это другой процесс с другими последствиями, и делать
 * вид, что это «ещё один пункт выпадающего списка», нельзя.
 */
export const AdminUserStatusChangeSchema = z.object({
  action: z.enum(['suspend', 'restore']),
  reason: boundedString(3, 500),
});
export type AdminUserStatusChange = z.infer<typeof AdminUserStatusChangeSchema>;

/** Изменение обычных профильных полей администратором. Проверенных данных не касается. */
export const AdminUserProfileUpdateSchema = z.object({
  displayName: boundedString(2, 120),
});
export type AdminUserProfileUpdate = z.infer<typeof AdminUserProfileUpdateSchema>;
