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
  ServiceAccountWithSecretSchema,
  type AdminPlan,
  type AdvanceProjectStageRequest,
  type AdminSubscription,
  type AuthSession,
  type ClosePlanRequest,
  type FeatureFlag,
  type KycVerification,
  type NotificationTemplate,
  type ProjectStageChange,
  type ProposeCustomPriceRequest,
  type PublishPlanRequest,
  type Season,
  type SeasonFunnelConfig,
  type SeasonStageOccupancy,
  type ServiceAccount,
  type ServiceAccountWithSecret,
  type UpdateDraftPlanRequest,
  type UpsertNotificationTemplate,
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

  proposeCustomPrice(id: string, input: ProposeCustomPriceRequest): Promise<AdminSubscription> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/subscriptions/${id}/custom-price`,
      body: input,
      schema: AdminSubscriptionSchema,
    });
  },

  approveCustomPrice(id: string): Promise<AdminSubscription> {
    return client.request({
      method: 'POST',
      path: `/v1/admin/subscriptions/${id}/custom-price/approve`,
      schema: AdminSubscriptionSchema,
    });
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
};
