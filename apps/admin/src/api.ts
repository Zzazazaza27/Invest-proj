import {
  TestingSessionListSchema,
  TestingSessionCardSchema,
  CleanupPlanSchema,
  CleanupResultSchema,
  OpenedContextSchema,
  FeaturesSchema,
  UiSkinSchema,
  type SkinId,
  type UiSkin,
} from '@fifth/contracts';
import { ApiClient, ApiError } from '@fifth/api-client';
import {
  AuthSessionSchema,
  FeatureFlagSchema,
  KycVerificationSchema,
  NotificationTemplateSchema,
  ServiceAccountSchema,
  StaffCapabilityGrantSchema,
  StaffCapabilitySchema,
  type StaffCapability,
  type StaffCapabilityGrant,
  SupportMessageSchema,
  SupportTicketDetailSchema,
  SupportTicketSchema,
  RequestKeyStateSchema,
  type RequestKeyState,
  type GuardedOperationName,
  AdminGroupStatusSchema,
  type AdminGroupStatus,
  type FunctionGroup,
  type SetRestrictionRequest,
  ServiceAccountWithSecretSchema,
  type AuthSession,
  type CreateServiceAccountRequest,
  type FeatureFlag,
  type KycVerification,
  type NotificationTemplate,
  type ServiceAccount,
  type CreateSupportTicketRequest,
  type SupportTicket,
  type SupportTicketDetail,
  type UpdateSupportTicketRequest,
  type ServiceAccountWithSecret,
  type UpsertNotificationTemplate,
  AdminProjectSummarySchema,
  AdminUserSummarySchema,
  AdminUserCardSchema,
  AdminUserContactsSchema,
  AdminUserPageSchema,
  MyProfileSchema,
  ChangePasswordResultSchema,
  MediaUploadTicketSchema,
  uuidv7,
  LanguageSchema,
  TextEntrySchema,
  TextVersionSchema,
  type Language,
  type TextEntry,
  type TextNamespace,
  type TextVersion,
  type UpsertTextEntry,
  type AdminProjectSummary,
  type AdminUserSummary,
  type AdminUserCard,
  type AdminUserContacts,
  type AdminUserPage,
  type MyProfile,
  ServiceCountrySchema,
  type ServiceCountry,
  type UpdateServiceCountryRequest,
} from '@fifth/contracts';
import { z } from 'zod';

/**
 * Единственное место в админке, которое знает про HTTP.
 *
 * Токен сессии живёт в httpOnly-cookie и недоступен этому коду — сюда попадает
 * только CSRF-токен, который сервер отдаёт в теле ответа и в читаемой cookie.
 * Схема double-submit: заголовок обязан совпасть со значением cookie.
 */

/**
 * Адрес API.
 *
 * По умолчанию берётся ТОТ ЖЕ хост, на котором открыта страница, и порт ядра.
 * Фиксированный `127.0.0.1` здесь был бы ловушкой: страница, открытая как
 * `localhost`, обращалась бы к `127.0.0.1` — для браузера это другой сайт, и
 * сессионная cookie на такой запрос не отправляется. Внешне это выглядит как
 * «вход не работает», хотя сервер отвечает корректно.
 */
/**
 * Здесь нужен ОРИГИН без версии: пути ниже уже содержат `/v1/…`.
 *
 * Документированная переменная `VITE_API_BASE_URL` задана с версией (так её
 * ожидают остальные приложения), и подстановка её как есть давала запросы вида
 * `/v1/v1/…`. Локально это не проявлялось только потому, что переменная не
 * задавалась и работал запасной вариант. Поэтому версия здесь снимается явно —
 * приложение принимает обе формы записи и не зависит от того, какую передали.
 */
function toOrigin(value: string): string {
  return value.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Порта в адресе страницы нет — значит приложение раздаётся через единую точку
 * входа, и API живёт на том же origin: базой служит пустая строка, а пути ниже
 * уже начинаются с `/v1/…`. Порт есть — прямой запуск dev-сервером, и ядро
 * слушает свой порт.
 */
/**
 * ЕДИНАЯ ТОЧКА ВХОДА ПОБЕЖДАЕТ ПЕРЕМЕННУЮ СБОРКИ.
 *
 * `VITE_API_BASE_URL` в `.env` задан абсолютным (`http://localhost:4300/v1`)
 * ради прямого запуска dev-серверами. Для собранной статики, которую nginx
 * раздаёт с `127.0.0.1`, этот адрес — ДРУГОЙ origin: вход проходит (201), а
 * следующий запрос получает 401, потому что cookie межсайтово не уходит.
 * Снаружи это выглядит как «кабинет не пускает», и причину ищут в
 * авторизации.
 *
 * Поэтому решает не переменная, а то, как открыта страница: порта в адресе
 * нет — значит единая точка входа, и API живёт на том же origin. Переменная
 * нужна только там, где порт есть, то есть при прямом запуске dev-сервером.
 */
const BASE_URL = toOrigin(
  window.location.port === ''
    ? ''
    : ((import.meta.env.VITE_API_BASE_URL as string | undefined) ??
        `${window.location.protocol}//${window.location.hostname}:4300`),
);

/**
 * Адрес API обязателен всюду, кроме локальной машины.
 *
 * Молчаливый переход на `hostname:4300` на реальном домене увёл бы
 * приложение на порт того же хоста по http — сессионная cookie ушла бы в
 * открытый канал (LOW внешнего аудита №2). Поэтому на не-локальном хосте это
 * ошибка запуска, а не «работает как-нибудь».
 *
 * Условие смотрит и на ПОРТ: пустой порт означает единую точку входа —
 * API там на том же origin по пути `/v1`, и угадывать нечего. Опасен
 * именно случай, когда приложение вынуждено подставить чужой порт.
 *
 * Проверяется ХОСТ, а не `import.meta.env.PROD`: локальные
 * браузерные прогоны поднимают ровно production-сборку, и жёсткая проверка
 * по PROD ломала бы их, ничего не защищая — на localhost адрес и так
 * локальный.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
if (
  !import.meta.env.VITE_API_BASE_URL &&
  window.location.port !== '' &&
  !LOCAL_HOSTS.has(window.location.hostname)
) {
  throw new Error('VITE_API_BASE_URL обязателен: адрес API не может выводиться из адреса страницы');
}

/**
 * Имя CSRF-cookie зависит от окружения: в production действует префикс
 * `__Host-`, вне его — обычное имя, потому что браузер отбрасывает
 * `__Host-`-cookie, поставленную без Secure по http.
 *
 * Поэтому имя не зашивается, а берётся из конфигурации сборки; на всякий
 * случай проверяются оба варианта — рассинхрон имени тихо ломает все
 * небезопасные запросы после перезагрузки страницы (проверено в браузере).
 */
/**
 * Роль в истории выдач. Форма подтверждена живым прогоном Ф9c: сервер отдаёт
 * список с моментом выдачи и снятия.
 */
const GrantedRoleSchema = z.object({
  role: z.string(),
  grantedAt: z.string(),
  revokedAt: z.string().nullable(),
});
type GrantedRole = z.infer<typeof GrantedRoleSchema>;

const CSRF_COOKIE_NAMES = [
  (import.meta.env.VITE_CSRF_COOKIE_NAME as string | undefined) ?? 'ul_csrf',
  '__Host-ul_csrf',
];

const client = new ApiClient({
  baseUrl: BASE_URL,
  auth: { kind: 'cookie', csrfToken: readCsrfCookie() },
});

function readCsrfCookie(): string | null {
  for (const name of CSRF_COOKIE_NAMES) {
    const match = new RegExp(
      `(?:^|;\\s*)${name.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}=([^;]+)`,
    ).exec(document.cookie);
    if (match?.[1]) return match[1];
  }
  return null;
}

function listOf<T>(schema: z.ZodType<T>) {
  return z.object({ items: z.array(schema) });
}

export { ApiError };

// --------------------------------------------------- Market Intelligence
// Схемы живут здесь, а не в contracts: раздел внутренний, у ответов один
// потребитель — эта админка. Модель — docs/product/market-intelligence/README.md.

export const INTEL_TYPES = [
  'person',
  'organization',
  'fund',
  'investor_club',
  'accelerator',
  'venture_studio',
  'bootcamp',
  'event',
  'platform',
  'media',
  'corporation',
  'program',
  'project',
  'other',
] as const;
export type IntelType = (typeof INTEL_TYPES)[number];
export const INTEL_STATUSES = ['raw', 'reviewed', 'interesting', 'contacted', 'archived'] as const;
export type IntelStatus = (typeof INTEL_STATUSES)[number];
export const INTEL_LEVELS = ['high', 'medium', 'low'] as const;
export const INTEL_CONTACTS = ['yes', 'partial', 'no'] as const;
export const INTEL_ALIVE = ['yes', 'no', 'unknown'] as const;
export const INTEL_DISCOVERY = ['direct', 'reverse', 'import', 'manual'] as const;
export const INTEL_PARSEABLE = ['yes', 'partial', 'no'] as const;
export const INTEL_REVIEW = ['unchecked', 'checked', 'unreachable'] as const;
export const INTEL_VERIFICATION = ['verified', 'candidate', 'rejected'] as const;
export const INTEL_SOURCE_VERIFICATION = ['candidate', 'verified', 'rejected'] as const;
export const INTEL_RELIABILITY = ['unassessed', 'reliable', 'doubtful'] as const;
export const INTEL_CRAWL_MODES = ['off', 'daily', 'weekly'] as const;
export const INTEL_CRAWL_EXTRACT = [
  'announcements',
  'jury',
  'speakers',
  'deals',
  'portfolio',
  'team',
  'calendar',
  'catalog',
] as const;
export type IntelVerification = (typeof INTEL_VERIFICATION)[number];
export const INTEL_SOURCE_TYPES = [
  'fund',
  'investor_club',
  'accelerator',
  'venture_studio',
  'incubator',
  'bootcamp',
  'demo_day',
  'pitch_session',
  'conference',
  'competition',
  'investment_platform',
  'crowdinvesting',
  'investor_catalog',
  'startup_catalog',
  'community',
  'corporate_program',
  'bank_program',
  'university_program',
  'gov_program',
  'market_portal',
  'aggregator',
  'event_calendar',
  'media',
  'news',
  'blog',
  'telegram',
  'general',
  'speaker_agency',
  'education',
  'own_site',
  'other',
] as const;

const IntelEntitySchema = z.object({
  id: z.string().uuid(),
  type: z.enum(INTEL_TYPES),
  name: z.string(),
  organizationName: z.string().nullable(),
  description: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  email: z.string().nullable(),
  telegram: z.string().nullable(),
  linkedin: z.string().nullable(),
  status: z.enum(INTEL_STATUSES),
  notes: z.string().nullable(),
  attributes: z.record(z.string(), z.unknown()),
  importSource: z.string().nullable(),
  externalUrl: z.string().nullable(),
  externalId: z.string().nullable(),
  importedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type IntelEntity = z.infer<typeof IntelEntitySchema>;

const IntelMetricsSchema = z.object({
  uniqueProfileSources: z.number(),
  profileFacts: z.number(),
  mediaFacts: z.number(),
  verifiedFacts: z.number(),
  candidateFacts: z.number(),
  firstProfileOn: z.string().nullable(),
  lastProfileOn: z.string().nullable(),
});
export type IntelMetrics = z.infer<typeof IntelMetricsSchema>;

const IntelRowSchema = IntelEntitySchema.extend({
  metrics: IntelMetricsSchema,
  duplicate: z.boolean(),
});
export type IntelRow = z.infer<typeof IntelRowSchema>;

const IntelSourceSchema = z.object({
  id: z.string().uuid(),
  url: z.string(),
  domain: z.string().nullable(),
  title: z.string().nullable(),
  name: z.string().nullable(),
  kind: z.string().nullable(),
  description: z.string().nullable(),
  obtainable: z.string().nullable(),
  structure: z.enum(INTEL_LEVELS).nullable(),
  publicContacts: z.enum(INTEL_CONTACTS).nullable(),
  alive: z.enum(INTEL_ALIVE).nullable(),
  parserPriority: z.enum(INTEL_LEVELS).nullable(),
  discovery: z.enum(INTEL_DISCOVERY),
  viaEntityId: z.string().uuid().nullable(),
  viaEntityName: z.string().nullable(),
  representsEntityId: z.string().uuid().nullable(),
  representsEntityName: z.string().nullable(),
  isProfile: z.boolean().nullable(),
  sourceType: z.enum(INTEL_SOURCE_TYPES).nullable(),
  hasEvents: z.boolean().nullable(),
  hasParticipantLists: z.boolean().nullable(),
  parseable: z.enum(INTEL_PARSEABLE).nullable(),
  reviewStatus: z.enum(INTEL_REVIEW),
  verification: z.enum(INTEL_SOURCE_VERIFICATION),
  reliability: z.enum(INTEL_RELIABILITY),
  crawlMode: z.enum(INTEL_CRAWL_MODES),
  crawlExtract: z.array(z.enum(INTEL_CRAWL_EXTRACT)),
  crawlRule: z.string().nullable(),
  platformReview: z.string().nullable(),
  platformReviewAt: z.string().nullable(),
  factCount: z.number(),
  verifiedCount: z.number(),
  entityCount: z.number(),
  discoveredAt: z.string(),
  lastCheckedAt: z.string().nullable(),
  updatedAt: z.string(),
  notes: z.string().nullable(),
});
export type IntelSource = z.infer<typeof IntelSourceSchema>;

const IntelFactSchema = z.object({
  id: z.string().uuid(),
  entityId: z.string().uuid(),
  entityName: z.string().nullable(),
  entityType: z.enum(INTEL_TYPES).nullable(),
  sourceId: z.string().uuid(),
  sourceName: z.string().nullable(),
  sourceUrl: z.string(),
  sourceDomain: z.string().nullable(),
  isProfileSource: z.boolean().nullable(),
  sourceType: z.string().nullable(),
  ownSource: z.boolean().nullable(),
  pageUrl: z.string().nullable(),
  role: z.string().nullable(),
  action: z.string().nullable(),
  organizationId: z.string().uuid().nullable(),
  organizationName: z.string().nullable(),
  eventId: z.string().uuid().nullable(),
  eventName: z.string().nullable(),
  happenedOn: z.string().nullable(),
  happenedPrecision: z.enum(['day', 'month', 'year']).nullable(),
  verification: z.enum(INTEL_VERIFICATION),
  verifiedAt: z.string().nullable(),
  evidence: z.string().nullable(),
  notes: z.string().nullable(),
  foundAt: z.string(),
  lastCheckedAt: z.string().nullable(),
});
export type IntelFact = z.infer<typeof IntelFactSchema>;

export interface IntelFactInput {
  role?: string | null;
  action?: string | null;
  happenedOn?: string | null;
  happenedPrecision?: 'day' | 'month' | 'year' | null;
  organizationId?: string | null;
  eventId?: string | null;
  verification?: IntelVerification;
  evidence?: string | null;
  notes?: string | null;
}

const IntelCardSchema = z.object({
  entity: IntelEntitySchema,
  metrics: IntelMetricsSchema,
  roles: z.array(
    z.object({
      role: z.string(),
      organizationId: z.string().uuid().nullable(),
      organizationName: z.string().nullable(),
      facts: z.number(),
    }),
  ),
  facts: z.array(IntelFactSchema),
  related: z.array(IntelFactSchema),
  ownSources: z.array(IntelSourceSchema),
  duplicates: z.array(
    z.object({
      id: z.string().uuid(),
      name: z.string(),
      type: z.string(),
      organizationName: z.string().nullable(),
    }),
  ),
});
export type IntelCard = z.infer<typeof IntelCardSchema>;

const IntelSourceCardSchema = z.object({
  source: IntelSourceSchema,
  facts: z.array(IntelFactSchema),
});
export type IntelSourceCard = z.infer<typeof IntelSourceCardSchema>;

export interface IntelSourceInput {
  url: string;
  name?: string | null;
  kind?: string | null;
  description?: string | null;
  obtainable?: string | null;
  structure?: string | null;
  publicContacts?: string | null;
  alive?: string | null;
  parserPriority?: string | null;
  discovery?: string;
  viaEntityId?: string | null;
  representsEntityId?: string | null;
  notes?: string | null;
  isProfile?: boolean | null;
  sourceType?: string | null;
  hasEvents?: boolean | null;
  hasParticipantLists?: boolean | null;
  parseable?: string | null;
  reviewStatus?: string;
  verification?: string;
  reliability?: string;
  crawlMode?: string;
  crawlExtract?: string[];
  crawlRule?: string | null;
  platformReview?: string | null;
}

export interface IntelEntityInput {
  type: IntelType;
  name: string;
  organizationName?: string | null;
  description?: string | null;
  websiteUrl?: string | null;
  email?: string | null;
  telegram?: string | null;
  linkedin?: string | null;
  status?: IntelStatus;
  notes?: string | null;
}

export const api = {
  /** Market Intelligence: профильная база инвестиционного рынка. */
  intelligence: {
    list: (filter: { q?: string; type?: string; status?: string }) => {
      const params = new URLSearchParams();
      if (filter.q) params.set('q', filter.q);
      if (filter.type) params.set('type', filter.type);
      if (filter.status) params.set('status', filter.status);
      const qs = params.toString();
      return client.request({
        path: `/v1/admin/intelligence/entities${qs ? `?${qs}` : ''}`,
        schema: listOf(IntelRowSchema),
      });
    },
    lookup: (q: string) =>
      client.request({
        path: `/v1/admin/intelligence/lookup?q=${encodeURIComponent(q)}`,
        schema: listOf(
          z.object({ id: z.string().uuid(), name: z.string(), type: z.enum(INTEL_TYPES) }),
        ),
      }),
    card: (id: string) =>
      client.request({ path: `/v1/admin/intelligence/entities/${id}`, schema: IntelCardSchema }),
    create: (body: IntelEntityInput & { sourceUrl?: string | null }) =>
      client.request({
        path: '/v1/admin/intelligence/entities',
        method: 'POST',
        body,
        schema: IntelCardSchema,
      }),
    update: (id: string, body: Partial<IntelEntityInput>) =>
      client.request({
        path: `/v1/admin/intelligence/entities/${id}`,
        method: 'PATCH',
        body,
        schema: IntelCardSchema,
      }),
    merge: (keepId: string, dropId: string) =>
      client.request({
        path: `/v1/admin/intelligence/entities/${keepId}/merge`,
        method: 'POST',
        body: { dropId },
        schema: IntelCardSchema,
      }),
    addFact: (id: string, body: IntelFactInput & { url: string }) =>
      client.request({
        path: `/v1/admin/intelligence/entities/${id}/facts`,
        method: 'POST',
        body,
        schema: IntelCardSchema,
      }),
    updateFact: (factId: string, body: IntelFactInput) =>
      client.request({
        path: `/v1/admin/intelligence/facts/${factId}`,
        method: 'PATCH',
        body,
        schema: IntelCardSchema,
      }),
    removeFact: (factId: string) =>
      client.request({
        path: `/v1/admin/intelligence/facts/${factId}`,
        method: 'DELETE',
        schema: z.object({ ok: z.boolean() }),
      }),
    asSource: (id: string, url: string | null) =>
      client.request({
        path: `/v1/admin/intelligence/entities/${id}/as-source`,
        method: 'POST',
        timeoutMs: 40_000,
        body: { url },
        schema: IntelCardSchema,
      }),
    sources: () =>
      client.request({ path: '/v1/admin/intelligence/sources', schema: listOf(IntelSourceSchema) }),
    sourceCard: (id: string) =>
      client.request({
        path: `/v1/admin/intelligence/sources/${id}`,
        schema: IntelSourceCardSchema,
      }),
    createSource: (body: IntelSourceInput) =>
      client.request({
        path: '/v1/admin/intelligence/sources',
        method: 'POST',
        timeoutMs: 40_000,
        body,
        schema: IntelSourceCardSchema.extend({
          fetched: z.boolean(),
          problem: z.string().nullable(),
        }),
      }),
    updateSource: (id: string, body: Partial<IntelSourceInput>) =>
      client.request({
        path: `/v1/admin/intelligence/sources/${id}`,
        method: 'PATCH',
        body,
        schema: IntelSourceCardSchema,
      }),
    removeSource: (id: string) =>
      client.request({
        path: `/v1/admin/intelligence/sources/${id}`,
        method: 'DELETE',
        schema: z.object({ ok: z.boolean() }),
      }),
    importGetInvestor: () =>
      client.request({
        path: '/v1/admin/intelligence/import/get-investor',
        method: 'POST',
        // Восемь каталогов по сети и несколько сотен записей: дольше обычного.
        timeoutMs: 120_000,
        schema: z.object({
          report: z.array(
            z.object({
              catalog: z.string(),
              fetched: z.number(),
              created: z.number(),
              updated: z.number(),
              error: z.string().optional(),
            }),
          ),
        }),
      }),
  },

  /**
   * Тестовые сессии (M129).
   *
   * Все вызовы идут под обычной административной сессией и БЕЗ заголовка
   * контекста: админка остаётся админкой. Заголовок ставит только та
   * вкладка, которую открыли кабинетом участника.
   */
  testing: {
    list: () =>
      client.request({ path: '/v1/admin/testing/sessions', schema: TestingSessionListSchema }),
    card: (id: string) =>
      client.request({
        path: `/v1/admin/testing/sessions/${id}`,
        schema: TestingSessionCardSchema,
      }),
    create: (body: { title: string }) =>
      client.request({
        path: '/v1/admin/testing/sessions',
        method: 'POST',
        body,
        schema: z.object({ id: z.string().uuid() }),
      }),
    finish: (id: string, result: 'unknown' | 'passed' | 'failed' = 'unknown') =>
      client.request({
        path: `/v1/admin/testing/sessions/${id}/finish`,
        method: 'POST',
        body: { result },
        schema: z.object({ ok: z.boolean() }),
      }),
    resume: (id: string) =>
      client.request({
        path: `/v1/admin/testing/sessions/${id}/resume`,
        method: 'POST',
        body: {},
        schema: z.object({ ok: z.boolean() }),
      }),
    cleanupPlan: (id: string) =>
      client.request({
        path: `/v1/admin/testing/sessions/${id}/cleanup`,
        schema: CleanupPlanSchema,
      }),
    cleanup: (id: string) =>
      client.request({
        path: `/v1/admin/testing/sessions/${id}/cleanup`,
        method: 'POST',
        body: {},
        schema: CleanupResultSchema,
      }),
    openParticipant: (sessionId: string, userId: string) =>
      client.request({
        path: `/v1/admin/testing/sessions/${sessionId}/contexts`,
        method: 'POST',
        body: { kind: 'participant', userId },
        schema: OpenedContextSchema,
      }),
    openGuest: (sessionId: string) =>
      client.request({
        path: `/v1/admin/testing/sessions/${sessionId}/contexts`,
        method: 'POST',
        body: { kind: 'guest' },
        schema: OpenedContextSchema,
      }),
    openUserView: (userId: string) =>
      client.request({
        path: '/v1/admin/testing/user-views',
        method: 'POST',
        body: { userId },
        schema: OpenedContextSchema,
      }),
  },

  async login(email: string, password: string): Promise<AuthSession> {
    const session = await client.request({
      method: 'POST',
      path: '/v1/auth/login',
      body: { email, password },
      schema: AuthSessionSchema,
    });
    // Токен из тела ответа, а не из cookie: cookie может быть ещё не записана
    // браузером на момент разбора ответа.
    client.setCsrfToken(session.csrfToken || readCsrfCookie());
    return session;
  },

  async me(): Promise<{
    id: string;
    displayName: string;
    roles: string[];
    avatarUrl?: string | null;
  }> {
    return client.request({
      method: 'GET',
      path: '/v1/auth/me',
      schema: z
        .object({
          id: z.string(),
          displayName: z.string(),
          roles: z.array(z.string()),
          // Аватар для шапки приходит вместе с «кто я»: отдельный запрос ради
          // одной картинки означал бы второй запрос на каждой странице.
          avatarUrl: z.string().nullable().optional(),
        })
        .loose(),
    });
  },

  async logout(): Promise<void> {
    await client.request({ method: 'POST', path: '/v1/auth/logout' });
    client.setCsrfToken(null);
  },

  // -------------------------------------------------------------- фичефлаги

  /** Доступность групп функций (4.11): исправность зависимости и ручной запрет раздельно. */
  async availability(): Promise<AdminGroupStatus[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/admin/availability',
      schema: listOf(AdminGroupStatusSchema),
    });
    return items;
  },

  restrictGroup(group: FunctionGroup, body: SetRestrictionRequest): Promise<AdminGroupStatus> {
    return client.request({
      method: 'PUT',
      path: `/v1/admin/availability/${group}`,
      body,
      schema: AdminGroupStatusSchema,
    });
  },

  clearGroupRestriction(group: FunctionGroup, note: string): Promise<AdminGroupStatus> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/availability/${group}/clear`,
      body: { note },
      schema: AdminGroupStatusSchema,
    });
  },

  async featureFlags(): Promise<FeatureFlag[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/admin/feature-flags',
      schema: listOf(FeatureFlagSchema),
    });
    return items;
  },

  setFeatureFlag(key: string, enabled: boolean, reason: string): Promise<FeatureFlag> {
    return client.request({
      method: 'PATCH',
      path: `/v1/admin/feature-flags/${key}`,
      body: { enabled, reason },
      schema: FeatureFlagSchema,
    });
  },

  /** Скин платформы, который сейчас видят все интерфейсы (публичный `/v1/features`). */
  async platformSkin(): Promise<SkinId> {
    const features = await client.request({
      method: 'GET',
      path: '/v1/features',
      schema: FeaturesSchema,
    });
    return features.skin;
  },

  /** Применить скин для всей платформы (M145): флаг `ui.skin`, с причиной и в журнал. */
  setPlatformSkin(skin: SkinId, reason: string): Promise<UiSkin> {
    return client.request({
      method: 'PUT',
      path: '/v1/admin/ui-skin',
      body: { skin, reason },
      schema: UiSkinSchema,
    });
  },

  // --------------------------------------------------------------- комплаенс

  /**
   * Страница очереди KYC. Прежний клиент выбрасывал `nextCursor`, и оператор
   * ФИЗИЧЕСКИ не мог увидеть заявки после первых 50: страницы за первой были
   * недостижимы из интерфейса (CODE-MED-01).
   */
  async kycQueue(
    cursor?: string,
  ): Promise<{ items: KycVerification[]; nextCursor: string | null }> {
    const page = await client.request({
      method: 'GET',
      path: cursor ? `/v1/kyc/queue?cursor=${encodeURIComponent(cursor)}` : '/v1/kyc/queue',
      schema: z.object({
        items: z.array(KycVerificationSchema),
        nextCursor: z.string().nullable(),
      }),
    });
    return page;
  },

  decideKyc(
    id: string,
    decision: 'approved' | 'rejected',
    reason?: string,
  ): Promise<KycVerification> {
    return client.request({
      method: 'POST',
      path: `/v1/kyc/verifications/${id}/decision`,
      body: reason ? { decision, reason } : { decision },
      schema: KycVerificationSchema,
    });
  },

  // ------------------------------------------------------------------ доступ

  /**
   * Роли пользователя. Сервер возвращает полную историю выдач и снятий: она
   * нужна, чтобы видеть не только текущее состояние прав, но и как оно
   * получилось.
   */
  // Идентификатор в пути кодируется: он приходит из свободного поля формы,
  // и без кодирования произвольные символы ломают маршрут (LOW аудита №2).
  // Валидация формата — на сервере (UuidSchema), здесь дешёвая гигиена.
  /**
   * Поиск людей и проектов.
   *
   * Нужен экранам, которые работают по идентификатору: набирать UUID руками
   * оператору неоткуда, а искать он умеет по имени.
   */

  /**
   * Поиск человека по имени.
   *
   * `includeProbes` — ЯВНОЕ решение того, кто ищет. По умолчанию выдача
   * такая же, как в списке пользователей: записи проверок скрыты, иначе
   * список рассказывал бы не о платформе, а о наших прогонах. Но иногда
   * искать нужно именно их — например, выдать полномочие учётной записи,
   * которую завёл прогон. Само собой это не включается: фильтр происхождения
   * не должен отменяться молча от того, что человек начал печатать.
   */
  searchUsers(
    query: string,
    options: { includeProbes?: boolean } = {},
  ): Promise<{ items: AdminUserSummary[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/admin/users',
      query: options.includeProbes ? { q: query, origin: 'all' } : { q: query },
      schema: z.object({ items: z.array(AdminUserSummarySchema) }),
    });
  },

  /**
   * Страница списка людей для раздела «Пользователи».
   *
   * Тот же маршрут, что у поиска на экране «Доступ», но читается целиком:
   * там нужен только список найденных, здесь — ещё и общее число, без
   * которого постраничная навигация слепая.
   */
  adminUsers(query: Record<string, string>): Promise<AdminUserPage> {
    return client.request({
      method: 'GET',
      path: '/v1/admin/users',
      query,
      schema: AdminUserPageSchema,
    });
  },

  adminUserCard(userId: string): Promise<AdminUserCard> {
    return client.request({
      method: 'GET',
      path: `/v1/admin/users/${encodeURIComponent(userId)}`,
      schema: AdminUserCardSchema,
    });
  },

  revealUserContacts(userId: string): Promise<AdminUserContacts> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/users/${encodeURIComponent(userId)}/contacts/reveal`,
      schema: AdminUserContactsSchema,
    });
  },

  changeUserStatus(
    userId: string,
    input: { action: 'suspend' | 'restore'; reason: string },
  ): Promise<AdminUserCard> {
    return client.request({
      method: 'PATCH',
      path: `/v1/admin/users/${encodeURIComponent(userId)}/status`,
      body: input,
      schema: AdminUserCardSchema,
    });
  },

  /**
   * «Мой профиль» администратора.
   *
   * Те же маршруты, что и у остальных кабинетов: профиль один на человека, и
   * администратор здесь ничем не особенный. Экран тоже общий —
   * `@fifth/cabinet`, а это только транспорт.
   */
  myProfile(): Promise<MyProfile> {
    return client.request({ method: 'GET', path: '/v1/me/profile', schema: MyProfileSchema });
  },

  updateMyName(displayName: string): Promise<MyProfile> {
    return client.request({
      method: 'PATCH',
      path: '/v1/me/profile',
      body: { displayName },
      schema: MyProfileSchema,
    });
  },

  changeMyPassword(input: { currentPassword: string; newPassword: string }) {
    return client.request({
      method: 'POST',
      path: '/v1/me/password',
      body: input,
      schema: ChangePasswordResultSchema,
    });
  },

  removeMyAvatar(): Promise<MyProfile> {
    return client.request({ method: 'DELETE', path: '/v1/me/avatar', schema: MyProfileSchema });
  },

  /** Билет → прямая отправка в хранилище → подтверждение. Байты мимо ядра. */
  async uploadMyAvatar(file: File): Promise<MyProfile> {
    const ticket = await client.request({
      method: 'POST',
      path: '/v1/me/avatar/upload',
      body: { contentType: file.type, sizeBytes: file.size },
      schema: MediaUploadTicketSchema,
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
    form.append('file', file);
    // Предел ожидания обязателен: отправка идёт напрямую в хранилище, мимо
    // ядра и его таймаутов.
    const uploaded = await fetch(ticket.uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!uploaded.ok) throw new Error(`Хранилище не приняло файл: HTTP ${uploaded.status}`);
    return client.request({
      method: 'POST',
      path: '/v1/me/avatar/finalize',
      schema: MyProfileSchema,
    });
  },

  updateUserProfile(userId: string, input: { displayName: string }): Promise<AdminUserCard> {
    return client.request({
      method: 'PATCH',
      path: `/v1/admin/users/${encodeURIComponent(userId)}/profile`,
      body: input,
      schema: AdminUserCardSchema,
    });
  },

  searchProjects(query: string): Promise<{ items: AdminProjectSummary[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/admin/projects',
      query: { q: query },
      schema: z.object({ items: z.array(AdminProjectSummarySchema) }),
    });
  },

  listRoles(userId: string): Promise<{ items: GrantedRole[] }> {
    return client.request({
      method: 'GET',
      path: `/v1/admin/users/${encodeURIComponent(userId)}/roles`,
      schema: z.object({ items: z.array(GrantedRoleSchema) }),
    });
  },

  grantRole(userId: string, role: string): Promise<{ items: GrantedRole[] }> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/users/${encodeURIComponent(userId)}/roles`,
      body: { role },
      schema: z.object({ items: z.array(GrantedRoleSchema) }),
    });
  },

  revokeRole(userId: string, role: string): Promise<{ items: GrantedRole[] }> {
    return client.request({
      method: 'DELETE',
      path: `/v1/admin/users/${encodeURIComponent(userId)}/roles/${role}`,
      schema: z.object({ items: z.array(GrantedRoleSchema) }),
    });
  },

  serviceAccounts(): Promise<{ items: ServiceAccount[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/admin/service-accounts',
      schema: z.object({ items: z.array(ServiceAccountSchema) }),
    });
  },

  /**
   * Новый клиент Integration API.
   *
   * Секрет возвращается ОДИН раз — в базе только Argon2id-хеш, «показать ещё
   * раз» невозможно by design. До Ф55 создать клиента из админки было нельзя:
   * список и ротация были, а завести первый аккаунт можно было только через
   * служебную консоль.
   */
  /** Ключ повтора (2.6): повтор после потерянного ответа второго аккаунта не создаёт. */
  createServiceAccount(
    body: CreateServiceAccountRequest,
    key?: string,
  ): Promise<ServiceAccountWithSecret> {
    return client.request({
      method: 'POST',
      path: '/v1/admin/service-accounts',
      body,
      schema: ServiceAccountWithSecretSchema,
      ...(key ? { idempotencyKey: key } : {}),
    });
  },

  /**
   * Приостановка и возобновление доступа внешней системы.
   *
   * Приостановка — не удаление: выданные токены перестают действовать по
   * эпохе, а сам клиент со своими скоупами остаётся, и доступ возвращается
   * одним действием. Удаление клиента, которого приостановили на время
   * разбирательства, стоило бы перевыпуска секрета на стороне контрагента.
   */
  setServiceAccountStatus(id: string, status: 'active' | 'suspended'): Promise<ServiceAccount> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/service-accounts/${encodeURIComponent(id)}/status`,
      body: { status },
      schema: ServiceAccountSchema,
    });
  },

  /** Ротация. Секрет возвращается ОДИН раз — в базе только Argon2id-хеш. */
  rotateServiceAccount(id: string, key?: string): Promise<ServiceAccountWithSecret> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/service-accounts/${id}/rotation`,
      schema: ServiceAccountWithSecretSchema,
      ...(key ? { idempotencyKey: key } : {}),
    });
  },

  // ------------------------------------------------------ шаблоны уведомлений

  async templates(): Promise<NotificationTemplate[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/admin/notification-templates',
      schema: z.object({ items: z.array(NotificationTemplateSchema) }),
    });
    return items;
  },

  saveTemplate(body: UpsertNotificationTemplate): Promise<NotificationTemplate> {
    return client.request({
      method: 'POST',
      path: '/v1/admin/notification-templates',
      body,
      schema: NotificationTemplateSchema,
    });
  },

  deactivateTemplate(id: string): Promise<NotificationTemplate> {
    return client.request({
      method: 'DELETE',
      path: `/v1/admin/notification-templates/${id}`,
      schema: NotificationTemplateSchema,
    });
  },

  // ------------------------------------------------------------- поддержка
  //
  // Отдельного «админского» маршрута поддержки нет и не нужно: сотрудник
  // ходит по тем же `/v1/support/*`, а границу видимости задаёт политика БД.
  // Второй набор маршрутов «для админа» означал бы второе место, где решается
  // доступ, — и они разошлись бы.
  async supportTickets(): Promise<SupportTicket[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/support/tickets',
      schema: z.object({ items: z.array(SupportTicketSchema) }),
    });
    return items;
  },

  supportTicket(id: string): Promise<SupportTicketDetail> {
    return client.request({
      method: 'GET',
      path: `/v1/support/tickets/${encodeURIComponent(id)}`,
      schema: SupportTicketDetailSchema,
    });
  },

  /** `key` — ключ повтора защищённой отправки (2.6). */
  openSupportTicket(body: CreateSupportTicketRequest, key?: string): Promise<SupportTicketDetail> {
    return client.request({
      method: 'POST',
      path: '/v1/support/tickets',
      body,
      schema: SupportTicketDetailSchema,
      idempotencyKey: key,
    });
  },

  replySupportTicket(id: string, body: string, key?: string) {
    return client.request({
      method: 'POST',
      path: `/v1/support/tickets/${encodeURIComponent(id)}/messages`,
      body: { body },
      schema: SupportMessageSchema,
      idempotencyKey: key,
    });
  },

  /** Исход своей защищённой отправки по ключу (2.6): только чтение. */
  requestState(operation: GuardedOperationName, key: string): Promise<RequestKeyState> {
    return client.request({
      path: `/v1/me/requests/${operation}/${encodeURIComponent(key)}`,
      schema: RequestKeyStateSchema,
    });
  },

  updateSupportTicket(id: string, body: UpdateSupportTicketRequest): Promise<SupportTicketDetail> {
    return client.request({
      method: 'PATCH',
      path: `/v1/support/tickets/${encodeURIComponent(id)}`,
      body,
      schema: SupportTicketDetailSchema,
    });
  },

  /**
   * Функциональные полномочия сотрудников (M097). Роль выдаётся отдельно,
   * выше на этой же странице; полномочие — «что вправе делать».
   */
  capabilities: {
    catalog: (): Promise<{ items: StaffCapability[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/capabilities',
        schema: listOf(StaffCapabilitySchema),
      }),
    grantsOf: (userId: string): Promise<{ items: StaffCapabilityGrant[] }> =>
      client.request({
        method: 'GET',
        path: `/v1/admin/capabilities/users/${encodeURIComponent(userId)}`,
        schema: listOf(StaffCapabilityGrantSchema),
      }),
    grant: (userId: string, capability: string, reason: string): Promise<StaffCapabilityGrant> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/capabilities/grant',
        body: { userId, capability, reason },
        schema: StaffCapabilityGrantSchema,
      }),
    revoke: (userId: string, capability: string, reason: string): Promise<{ revoked: boolean }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/capabilities/revoke',
        body: { userId, capability, reason },
        schema: z.object({ revoked: z.boolean() }),
      }),
  },

  /** Страны обслуживания (этап 5.6.5): справочник строками. */
  serviceCountries: {
    admin: {
      list: (): Promise<{ items: ServiceCountry[] }> =>
        client.request({
          method: 'GET',
          path: '/v1/admin/service-countries',
          schema: listOf(ServiceCountrySchema),
        }),
      create: (code: string): Promise<ServiceCountry> =>
        client.request({
          method: 'POST',
          path: '/v1/admin/service-countries',
          body: { code },
          schema: ServiceCountrySchema,
          idempotencyKey: uuidv7(),
        }),
      update: (code: string, body: UpdateServiceCountryRequest): Promise<ServiceCountry> =>
        client.request({
          method: 'PATCH',
          path: `/v1/admin/service-countries/${encodeURIComponent(code)}`,
          body,
          schema: ServiceCountrySchema,
        }),
    },
  },
  texts: {
    languages: async (): Promise<Language[]> => {
      const { items } = await client.request({
        method: 'GET',
        path: '/v1/content/languages',
        schema: listOf(LanguageSchema),
      });
      return items;
    },
    list: async (namespace: TextNamespace): Promise<TextEntry[]> => {
      const { items } = await client.request({
        method: 'GET',
        path: `/v1/admin/content/texts?namespace=${namespace}`,
        schema: listOf(TextEntrySchema),
      });
      return items;
    },
    upsert: (namespace: TextNamespace, key: string, body: UpsertTextEntry): Promise<TextEntry> =>
      client.request({
        method: 'PUT',
        path: `/v1/admin/content/texts/${namespace}/${encodeURIComponent(key)}`,
        body,
        schema: TextEntrySchema,
      }),
    history: async (namespace: TextNamespace, key: string): Promise<TextVersion[]> => {
      const { items } = await client.request({
        method: 'GET',
        path: `/v1/admin/content/texts/${namespace}/${encodeURIComponent(key)}/history`,
        schema: listOf(TextVersionSchema),
      });
      return items;
    },
  },
};
