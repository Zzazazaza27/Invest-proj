import { ApiClient, ApiError } from '@unicorn/api-client';
import {
  AdminPlanSchema,
  AdminSubscriptionSchema,
  AuthSessionSchema,
  FeatureFlagSchema,
  KycVerificationSchema,
  SeasonSchema,
  type AdminPlan,
  type AdminSubscription,
  type AuthSession,
  type ClosePlanRequest,
  type FeatureFlag,
  type KycVerification,
  type ProposeCustomPriceRequest,
  type PublishPlanRequest,
  type Season,
  type UpdateDraftPlanRequest,
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
const BASE_URL =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  `${window.location.protocol}//${window.location.hostname}:4300`;

/**
 * Имя CSRF-cookie зависит от окружения: в production действует префикс
 * `__Host-`, вне его — обычное имя, потому что браузер отбрасывает
 * `__Host-`-cookie, поставленную без Secure по http.
 *
 * Поэтому имя не зашивается, а берётся из конфигурации сборки; на всякий
 * случай проверяются оба варианта — рассинхрон имени тихо ломает все
 * небезопасные запросы после перезагрузки страницы (проверено в браузере).
 */
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

  async kycQueue(): Promise<KycVerification[]> {
    const { items } = await client.request({
      method: 'GET',
      path: '/v1/kyc/queue',
      schema: listOf(KycVerificationSchema),
    });
    return items;
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

  changeSeasonStatus(id: string, status: Season['status']): Promise<Season> {
    return client.request({
      method: 'POST',
      path: `/v1/seasons/${id}/status`,
      body: { status },
      schema: SeasonSchema,
    });
  },
};
