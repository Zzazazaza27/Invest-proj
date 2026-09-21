import { ApiClient, ApiError } from '@unicorn/api-client';
import {
  AdminPlanSchema,
  AdminSubscriptionSchema,
  AuthSessionSchema,
  FeatureFlagSchema,
  KycVerificationSchema,
  NotificationTemplateSchema,
  ProjectStageChangeSchema,
  SeasonFunnelConfigSchema,
  SeasonSchema,
  SeasonStageOccupancySchema,
  ServiceAccountSchema,
  CommissionAdjustmentSchema,
  DealLedgerSchema,
  DealSummarySchema,
  FeeOffsetRuleSchema,
  PlanCapabilitySchema,
  type LinkPlanCapabilityRequest,
  type PlanCapability,
  type SetCapabilityBaselineRequest,
  DealSupportAssignmentRowSchema,
  ExpertConflictSchema,
  DealSupportAssignmentSchema,
  ProjectReviewAssignmentSchema,
  StaffCapabilityGrantSchema,
  StaffCapabilitySchema,
  TrancheReturnSchema,
  type CommissionAdjustment,
  type DealLedger,
  type DealSummary,
  type RecordCommissionAdjustmentRequest,
  type RecordTrancheReturnRequest,
  type DealSupportAssignment,
  type DealSupportAssignmentRow,
  type ExpertConflict,
  type ProjectReviewAssignment,
  type StaffCapability,
  type StaffCapabilityGrant,
  type TrancheReturn,
  FeeTermsSchema,
  type ActivateFeeOffsetRuleRequest,
  type FeeOffsetRule,
  type FeeTerms,
  type PublishFeeTermsRequest,
  RoundPackageSchema,
  PaymentProviderStatusSchema,
  RoundPurchaseViewSchema,
  type PaymentProviderStatus,
  type RoundPurchaseView,
  RoundServiceOfferSchema,
  RoundServiceSchema,
  type CloseRoundPackageRequest,
  type CreateRoundServiceRequest,
  type PublishRoundPackageRequest,
  type PublishRoundServiceOfferRequest,
  type RoundPackage,
  type RoundService,
  type RoundServiceOffer,
  type UpdateRoundServiceRequest,
  SupportMessageSchema,
  SupportTicketDetailSchema,
  SupportTicketSchema,
  ServiceAccountWithSecretSchema,
  type AdminPlan,
  type AdvanceProjectStageRequest,
  type AdminSubscription,
  type AuthSession,
  type ClosePlanRequest,
  type CreateServiceAccountRequest,
  type FeatureFlag,
  type KycVerification,
  type NotificationTemplate,
  type ProjectStageChange,
  type PublishPlanRequest,
  type Season,
  type SeasonFunnelConfig,
  type SeasonStageOccupancy,
  type ServiceAccount,
  type CreateSupportTicketRequest,
  type SupportTicket,
  type SupportTicketDetail,
  type UpdateSupportTicketRequest,
  type ServiceAccountWithSecret,
  type UpdateDraftPlanRequest,
  type UpsertNotificationTemplate,
  AdminProjectSummarySchema,
  AdminUserSummarySchema,
  AdminUserCardSchema,
  AdminUserContactsSchema,
  AdminUserPageSchema,
  uuidv7,
  ApplicationFormVersionSchema,
  ApplicationFormVersionsSchema,
  ApplicationFormViewSchema,
  ApplicationPolicyVersionSchema,
  LanguageSchema,
  ReadinessConfigVersionSchema,
  TextEntrySchema,
  TextVersionSchema,
  type ApplicationFormConfig,
  type ApplicationFormVersion,
  type ApplicationFormVersions,
  type ApplicationFormView,
  type ApplicationPolicy,
  type ApplicationPolicyVersion,
  type Language,
  type ProjectStage,
  type ReadinessConfig,
  type ReadinessConfigVersion,
  type TextEntry,
  type TextNamespace,
  type TextVersion,
  type UpsertTextEntry,
  AiProviderCheckResultSchema,
  AiProviderModelsSchema,
  AiProviderCredentialSchema,
  ScoringReviewItemSchema,
  type AiProviderCheckResult,
  type AiProviderModels,
  type ListAiProviderModelsRequest,
  type AiProviderCredential,
  type ScoringReviewItem,
  type UpsertAiProviderCredentialRequest,
  type AdminProjectSummary,
  type AdminUserSummary,
  type AdminUserCard,
  type AdminUserContacts,
  type AdminUserPage,
  ServiceCountrySchema,
  ServiceCountryPolicyVersionSchema,
  type ServiceCountry,
  type ServiceCountryPolicy,
  type ServiceCountryPolicyVersion,
  type UpdateServiceCountryRequest,
} from '@unicorn/contracts';
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
const BASE_URL = toOrigin(
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
    (window.location.port === ''
      ? ''
      : `${window.location.protocol}//${window.location.hostname}:4300`),
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

export const api = {
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

  async me(): Promise<{ id: string; displayName: string; roles: string[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/auth/me',
      schema: z
        .object({
          id: z.string(),
          displayName: z.string(),
          roles: z.array(z.string()),
        })
        .loose(),
    });
  },

  async logout(): Promise<void> {
    await client.request({ method: 'POST', path: '/v1/auth/logout' });
    client.setCsrfToken(null);
  },

  // ------------------------------------------------------------------ тарифы

  async plans(): Promise<AdminPlan[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/admin/plans',
      schema: listOf(AdminPlanSchema),
    });
    return items;
  },

  publishPlan(input: PublishPlanRequest): Promise<AdminPlan> {
    return client.request({
      method: 'POST',
      path: '/v1/admin/plans',
      body: input,
      schema: AdminPlanSchema,
    });
  },

  updateDraftPlan(id: string, input: UpdateDraftPlanRequest): Promise<AdminPlan> {
    return client.request({
      method: 'PATCH',
      path: `/v1/admin/plans/${id}`,
      body: input,
      schema: AdminPlanSchema,
    });
  },

  cancelScheduledPlan(id: string): Promise<{ ok: boolean }> {
    return client.request({
      method: 'DELETE',
      path: `/v1/admin/plans/${id}`,
      schema: z.object({ ok: z.boolean() }),
    });
  },

  closePlan(id: string, input: ClosePlanRequest): Promise<AdminPlan> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/plans/${id}/close`,
      body: input,
      schema: AdminPlanSchema,
    });
  },

  // ---------------------------------------------------------------- подписки

  async subscriptions(): Promise<AdminSubscription[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/admin/subscriptions',
      schema: listOf(AdminSubscriptionSchema),
    });
    return items;
  },

  activateSubscription(id: string, reason: string): Promise<AdminSubscription> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/subscriptions/${id}/activate`,
      body: { reason },
      schema: AdminSubscriptionSchema,
    });
  },

  // -------------------------------------------------------------- фичефлаги

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

  // ------------------------------------------------------------------ сезон

  async currentSeason(): Promise<Season | null> {
    const { season } = await client.request({
      method: 'GET',
      path: '/v1/seasons/current',
      schema: z.object({ season: SeasonSchema.nullable() }),
    });
    return season;
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
   * Ключ LLM-провайдера (ADR-008 §2). Панель отправляет ключ один раз и
   * обратно получает только отпечаток: прочитать ключ через API нельзя.
   */
  aiCredentials(): Promise<{ items: AiProviderCredential[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/admin/ai/credentials',
      schema: z.object({ items: z.array(AiProviderCredentialSchema) }),
    });
  },

  upsertAiCredential(body: UpsertAiProviderCredentialRequest): Promise<AiProviderCredential> {
    return client.request({
      method: 'PUT',
      path: '/v1/admin/ai/credentials',
      body,
      schema: AiProviderCredentialSchema,
    });
  },

  revokeAiCredential(provider: string, reason: string): Promise<{ revoked: boolean }> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/ai/credentials/${encodeURIComponent(provider)}/revoke`,
      body: { reason },
      schema: z.object({ revoked: z.boolean() }),
    });
  },

  aiProviderModels(body: ListAiProviderModelsRequest): Promise<AiProviderModels> {
    return client.request({
      method: 'POST',
      path: '/v1/admin/ai/credentials/models',
      body,
      schema: AiProviderModelsSchema,
    });
  },
  checkAiCredential(provider: string): Promise<AiProviderCheckResult> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/ai/credentials/${encodeURIComponent(provider)}/check`,
      body: {},
      schema: AiProviderCheckResultSchema,
    });
  },

  /** Оценки ИИ, ждущие решения человека (ADR-008 §4). */
  scoringReviews(): Promise<{ items: ScoringReviewItem[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/projects/scoring-reviews',
      schema: z.object({ items: z.array(ScoringReviewItemSchema) }),
    });
  },

  decideScoringReview(
    passportId: string,
    decision: 'confirm' | 'reject' | 'allow' | 'block',
    reason: string,
  ): Promise<ScoringReviewItem> {
    return client.request({
      method: 'POST',
      path: `/v1/projects/scoring-reviews/${encodeURIComponent(passportId)}/decision`,
      body: { decision, reason },
      schema: ScoringReviewItemSchema,
    });
  },

  searchUsers(query: string): Promise<{ items: AdminUserSummary[] }> {
    return client.request({
      method: 'GET',
      path: '/v1/admin/users',
      query: { q: query },
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
  createServiceAccount(body: CreateServiceAccountRequest): Promise<ServiceAccountWithSecret> {
    return client.request({
      method: 'POST',
      path: '/v1/admin/service-accounts',
      body,
      schema: ServiceAccountWithSecretSchema,
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
  rotateServiceAccount(id: string): Promise<ServiceAccountWithSecret> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/service-accounts/${id}/rotation`,
      schema: ServiceAccountWithSecretSchema,
    });
  },

  changeSeasonStatus(id: string, status: Season['status']): Promise<Season> {
    return client.request({
      method: 'POST',
      path: `/v1/seasons/${id}/status`,
      body: { status },
      schema: SeasonSchema,
    });
  },

  // ------------------------------------------------------------- воронка сезона

  /** Занятость этапов: сколько мест занято и сколько осталось по квоте. */
  async funnel(seasonId: string): Promise<SeasonStageOccupancy[]> {
    const { items } = await client.request({
      method: 'GET',
      path: `/v1/seasons/${seasonId}/funnel`,
      schema: z.object({ items: z.array(SeasonStageOccupancySchema) }),
    });
    return items;
  },

  setFunnel(seasonId: string, config: SeasonFunnelConfig): Promise<SeasonFunnelConfig> {
    return client.request({
      method: 'POST',
      path: `/v1/seasons/${seasonId}/funnel`,
      body: config,
      schema: SeasonFunnelConfigSchema,
    });
  },

  advanceStage(
    seasonId: string,
    projectId: string,
    body: AdvanceProjectStageRequest,
  ): Promise<ProjectStageChange> {
    return client.request({
      method: 'POST',
      path: `/v1/seasons/${seasonId}/projects/${projectId}/stage`,
      body,
      schema: ProjectStageChangeSchema,
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

  openSupportTicket(body: CreateSupportTicketRequest): Promise<SupportTicketDetail> {
    return client.request({
      method: 'POST',
      path: '/v1/support/tickets',
      body,
      schema: SupportTicketDetailSchema,
    });
  },

  replySupportTicket(id: string, body: string) {
    return client.request({
      method: 'POST',
      path: `/v1/support/tickets/${encodeURIComponent(id)}/messages`,
      body: { body },
      schema: SupportMessageSchema,
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

  // ------------------------------------------ вопросы заявки (этап 5, план 0.2 §0в)

  applicationForms: {
    list: (): Promise<ApplicationFormVersions> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/application-forms',
        schema: ApplicationFormVersionsSchema,
      }),
    draft: (): Promise<ApplicationFormVersion> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/application-forms/draft',
        schema: ApplicationFormVersionSchema,
      }),
    version: (version: number): Promise<ApplicationFormVersion> =>
      client.request({
        method: 'GET',
        path: `/v1/admin/application-forms/${version}`,
        schema: ApplicationFormVersionSchema,
      }),
    saveDraft: (config: ApplicationFormConfig): Promise<ApplicationFormVersion> =>
      client.request({
        method: 'PUT',
        path: '/v1/admin/application-forms/draft',
        body: { config },
        schema: ApplicationFormVersionSchema,
      }),
    preview: (stage: ProjectStage, locale: string): Promise<ApplicationFormView> =>
      client.request({
        method: 'GET',
        path: `/v1/admin/application-forms/draft/preview?stage=${stage}&locale=${encodeURIComponent(locale)}`,
        schema: ApplicationFormViewSchema,
      }),
    publish: (reason: string): Promise<ApplicationFormVersion> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/application-forms/draft/publish',
        body: { reason },
        schema: ApplicationFormVersionSchema,
        idempotencyKey: uuidv7(),
      }),
    activate: (version: number, reason: string): Promise<ApplicationFormVersion> =>
      client.request({
        method: 'POST',
        path: `/v1/admin/application-forms/${version}/activate`,
        body: { reason },
        schema: ApplicationFormVersionSchema,
        idempotencyKey: uuidv7(),
      }),
  },

  // --------------------------------------------- веса готовности (план 0.2 §2.7)

  readinessConfigs: {
    list: async (): Promise<ReadinessConfigVersion[]> => {
      const { items } = await client.request({
        method: 'GET',
        path: '/v1/admin/readiness-configs',
        schema: listOf(ReadinessConfigVersionSchema),
      });
      return items;
    },
    activate: (config: ReadinessConfig, reason: string): Promise<ReadinessConfigVersion> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/readiness-configs',
        body: { config, reason },
        schema: ReadinessConfigVersionSchema,
        idempotencyKey: uuidv7(),
      }),
  },

  // --------------------------------------- политика ограничений (план 0.2 §2.8)

  applicationPolicies: {
    list: async (): Promise<ApplicationPolicyVersion[]> => {
      const { items } = await client.request({
        method: 'GET',
        path: '/v1/admin/application-policies',
        schema: listOf(ApplicationPolicyVersionSchema),
      });
      return items;
    },
    activate: (config: ApplicationPolicy, reason: string): Promise<ApplicationPolicyVersion> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/application-policies',
        body: { config, reason },
        schema: ApplicationPolicyVersionSchema,
        idempotencyKey: uuidv7(),
      }),
  },

  // ------------------------------------------- словарь и ЧАВО (план 0.2 §2.6)

  /**
   * Ручные денежные записи по сделке (M097) и каталог полномочий.
   *
   * «Зафиксировать возврат» — запись о состоявшемся событии, а не платёжная
   * команда: платформа денег не перечисляет.
   */
  deals: {
    list: (): Promise<{ items: DealSummary[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/investments/deals',
        schema: listOf(DealSummarySchema),
      }),
    ledger: (id: string): Promise<DealLedger> =>
      client.request({
        method: 'GET',
        path: `/v1/investments/deals/${encodeURIComponent(id)}/ledger`,
        schema: DealLedgerSchema,
      }),
    recordReturn: (body: RecordTrancheReturnRequest): Promise<TrancheReturn> =>
      client.request({
        method: 'POST',
        path: '/v1/investments/deals/tranche-returns',
        body,
        schema: TrancheReturnSchema,
      }),
    cancelReturn: (id: string, reason: string): Promise<TrancheReturn> =>
      client.request({
        method: 'POST',
        path: `/v1/investments/deals/tranche-returns/${encodeURIComponent(id)}/cancel`,
        body: { reason },
        schema: TrancheReturnSchema,
      }),
    adjustCommission: (body: RecordCommissionAdjustmentRequest): Promise<CommissionAdjustment> =>
      client.request({
        method: 'POST',
        path: '/v1/investments/deals/commission-adjustments',
        body,
        schema: CommissionAdjustmentSchema,
      }),
  },

  /**
   * Возможности тарифов инвестора (5.9.4). Настраивается состав тарифа;
   * платные ограничения не включаются, базовый просмотр не закрывается.
   */
  planCapabilities: {
    list: (): Promise<{ items: PlanCapability[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/plan-capabilities',
        schema: listOf(PlanCapabilitySchema),
      }),
    link: (body: LinkPlanCapabilityRequest): Promise<{ items: PlanCapability[] }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/plan-capabilities/link',
        body,
        schema: listOf(PlanCapabilitySchema),
      }),
    setBaseline: (body: SetCapabilityBaselineRequest): Promise<{ items: PlanCapability[] }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/plan-capabilities/baseline',
        body,
        schema: listOf(PlanCapabilitySchema),
      }),
    unlink: (body: LinkPlanCapabilityRequest): Promise<{ items: PlanCapability[] }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/plan-capabilities/unlink',
        body,
        schema: listOf(PlanCapabilitySchema),
      }),
  },

  /**
   * Функциональные полномочия сотрудников и области их работы (M097, M099).
   *
   * Три РАЗНЫХ условия доступа, и экран обязан их различать: роль (выдаётся
   * отдельно, выше на этой же странице), полномочие «что вправе делать» и
   * назначение «с какими объектами».
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
    dealSupport: (filter: {
      projectId?: string;
      userId?: string;
    }): Promise<{ items: DealSupportAssignmentRow[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/capabilities/deal-support',
        query: {
          ...(filter.projectId ? { projectId: filter.projectId } : {}),
          ...(filter.userId ? { userId: filter.userId } : {}),
        },
        schema: listOf(DealSupportAssignmentRowSchema),
      }),
    assignDealSupport: (
      projectId: string,
      userId: string,
      reason: string,
    ): Promise<DealSupportAssignment> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/capabilities/deal-support',
        body: { projectId, userId, reason },
        schema: DealSupportAssignmentSchema,
      }),
    revokeDealSupport: (
      projectId: string,
      userId: string,
      reason: string,
    ): Promise<{ revoked: boolean }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/capabilities/deal-support/revoke',
        body: { projectId, userId, reason },
        schema: z.object({ revoked: z.boolean() }),
      }),
  },

  /** Назначения на ОЦЕНКУ проекта — другое условие доступа, чем сопровождение. */
  expertAssignments: {
    ofProject: (projectId: string): Promise<{ items: ProjectReviewAssignment[] }> =>
      client.request({
        method: 'GET',
        path: `/v1/experts/projects/${encodeURIComponent(projectId)}/assignments`,
        schema: listOf(ProjectReviewAssignmentSchema),
      }),
    assign: (
      projectId: string,
      expertIds: string[],
      dueAt: string,
    ): Promise<{ items: unknown[] }> =>
      client.request({
        method: 'POST',
        path: '/v1/experts/assignments',
        body: { projectId, expertIds, dueAt, reason: 'manual' },
        schema: z.object({ items: z.array(z.unknown()) }),
      }),
    /**
     * Прекратить ДОСТУП по назначению. Работу не отменяет: поданная рецензия
     * и её авторство остаются (M120).
     */
    revokeAccess: (assignmentId: string, reason: string): Promise<ProjectReviewAssignment> =>
      client.request({
        method: 'POST',
        path: `/v1/experts/assignments/${encodeURIComponent(assignmentId)}/revoke-access`,
        body: { reason },
        schema: ProjectReviewAssignmentSchema,
      }),
    /** Заявленные конфликты интересов по проекту — показать ДО назначения. */
    conflictsOfProject: (projectId: string): Promise<{ items: ExpertConflict[] }> =>
      client.request({
        method: 'GET',
        path: `/v1/experts/projects/${encodeURIComponent(projectId)}/conflicts`,
        schema: listOf(ExpertConflictSchema),
      }),
  },

  /**
   * Вознаграждение платформы и зачёт услуг (этап 5.9.3): версии условий со
   * ставкой и долями, версии правила зачёта. Начисления здесь не создаются.
   */
  commission: {
    terms: (): Promise<{ items: FeeTerms[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/fee-schedules',
        schema: listOf(FeeTermsSchema),
      }),
    publishTerms: (body: PublishFeeTermsRequest): Promise<FeeTerms> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/fee-schedules',
        body,
        schema: FeeTermsSchema,
        idempotencyKey: uuidv7(),
      }),
    offsetRules: (): Promise<{ items: FeeOffsetRule[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/fee-offset-rules',
        schema: listOf(FeeOffsetRuleSchema),
      }),
    activateOffsetRule: (body: ActivateFeeOffsetRuleRequest): Promise<FeeOffsetRule> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/fee-offset-rules',
        body,
        schema: FeeOffsetRuleSchema,
        idempotencyKey: uuidv7(),
      }),
  },

  /**
   * Покупки запуска раунда (5.9.7): подтверждение тестовой оплаты и отметка
   * выполнения услуг. Настоящих платежей здесь нет.
   */
  /**
   * Подключение оператора онлайн-платежей (5.9.9). Только чтение: провайдер и
   * ключ проверки подписи живут в окружении, а не в настройках продукта.
   */
  payments: {
    provider: (): Promise<PaymentProviderStatus> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/payments/provider',
        schema: PaymentProviderStatusSchema,
      }),
  },

  roundPurchases: {
    list: (): Promise<{ items: RoundPurchaseView[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/round-purchases',
        schema: listOf(RoundPurchaseViewSchema),
      }),
    confirmTestPayment: (id: string): Promise<RoundPurchaseView> =>
      client.request({
        method: 'POST',
        path: `/v1/admin/round-purchases/${encodeURIComponent(id)}/test-payment`,
        schema: RoundPurchaseViewSchema,
        idempotencyKey: uuidv7(),
      }),
    setFulfillment: (
      itemId: string,
      body: { status: 'planned' | 'in_progress' | 'fulfilled' | 'not_fulfilled'; note: string },
    ): Promise<RoundPurchaseView> =>
      client.request({
        method: 'POST',
        path: `/v1/admin/round-purchases/items/${encodeURIComponent(itemId)}/fulfillment`,
        body,
        schema: RoundPurchaseViewSchema,
      }),
    addAlternative: (body: {
      packageId: string;
      alternativeId: string;
      reason: string;
    }): Promise<{ items: RoundPackage[]; warning: string | null }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/round-packages/alternatives',
        body,
        schema: listOf(RoundPackageSchema).extend({ warning: z.string().nullable() }),
      }),
    removeAlternative: (body: {
      packageId: string;
      alternativeId: string;
      reason: string;
    }): Promise<{ items: RoundPackage[] }> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/round-packages/alternatives/remove',
        body,
        schema: listOf(RoundPackageSchema),
      }),
  },

  /**
   * Пакеты запуска раунда (этап 5.9.1): каталог услуг, версии пакетов и цены
   * докупки. Только настройка предложения — продаж здесь нет.
   */
  roundPackages: {
    services: (): Promise<{ items: RoundService[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/round-services',
        schema: listOf(RoundServiceSchema),
      }),
    createService: (body: CreateRoundServiceRequest): Promise<RoundService> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/round-services',
        body,
        schema: RoundServiceSchema,
        idempotencyKey: uuidv7(),
      }),
    updateService: (id: string, body: UpdateRoundServiceRequest): Promise<RoundService> =>
      client.request({
        method: 'PATCH',
        path: `/v1/admin/round-services/${encodeURIComponent(id)}`,
        body,
        schema: RoundServiceSchema,
      }),
    list: (): Promise<{ items: RoundPackage[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/round-packages',
        schema: listOf(RoundPackageSchema),
      }),
    publish: (body: PublishRoundPackageRequest): Promise<RoundPackage> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/round-packages',
        body,
        schema: RoundPackageSchema,
        idempotencyKey: uuidv7(),
      }),
    close: (id: string, body: CloseRoundPackageRequest): Promise<RoundPackage> =>
      client.request({
        method: 'POST',
        path: `/v1/admin/round-packages/${encodeURIComponent(id)}/close`,
        body,
        schema: RoundPackageSchema,
        idempotencyKey: uuidv7(),
      }),
    offers: (): Promise<{ items: RoundServiceOffer[] }> =>
      client.request({
        method: 'GET',
        path: '/v1/admin/round-service-offers',
        schema: listOf(RoundServiceOfferSchema),
      }),
    publishOffer: (body: PublishRoundServiceOfferRequest): Promise<RoundServiceOffer> =>
      client.request({
        method: 'POST',
        path: '/v1/admin/round-service-offers',
        body,
        schema: RoundServiceOfferSchema,
        idempotencyKey: uuidv7(),
      }),
  },

  /** Страны обслуживания и их условия (этап 5.6.5): справочник строками, условия версиями. */
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
      policies: (code: string): Promise<{ items: ServiceCountryPolicyVersion[] }> =>
        client.request({
          method: 'GET',
          path: `/v1/admin/service-countries/${encodeURIComponent(code)}/policies`,
          schema: listOf(ServiceCountryPolicyVersionSchema),
        }),
      activatePolicy: (
        code: string,
        body: { config: ServiceCountryPolicy; reason: string },
      ): Promise<ServiceCountryPolicyVersion> =>
        client.request({
          method: 'POST',
          path: `/v1/admin/service-countries/${encodeURIComponent(code)}/policies`,
          body,
          schema: ServiceCountryPolicyVersionSchema,
          idempotencyKey: uuidv7(),
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
