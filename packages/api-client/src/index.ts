import {
  AuthSessionSchema,
  CommissionAccrualSchema,
  CurrentUserSchema,
  ExpertAssignmentSchema,
  HealthSchema,
  InvestmentAgreementSchema,
  InvestmentOfferSchema,
  InvestmentPassportSchema,
  InvoiceSchema,
  MentorAnswerSchema,
  NotificationSchema,
  PaymentSchema,
  PricingSchema,
  ProjectFullSchema,
  ProjectTeaserSchema,
  RatingEntrySchema,
  SeasonSchema,
  SubscriptionSchema,
  TaxonomyNodeSchema,
  pageResponseSchema,
  uuidv7,
  type AcceptOfferRequest,
  type AddProductLink,
  type CatalogFilter,
  type CreateEntityRequest,
  type CreateOfferRequest,
  type CreatePaymentRequest,
  type CreateProjectRequest,
  type CreateSubscriptionRequest,
  type LoginRequest,
  type MentorQuestion,
  type NotificationPreference,
  type PublicationConsentRequest,
  type RegisterDeviceRequest,
  type RegisterRequest,
  type RequestUpload,
  type SignAgreementRequest,
  type SubmitReviewRequest,
  type UpdateProjectRequest,
} from '@unicorn/contracts';
import { z } from 'zod';
import { ApiClient, type ClientOptions } from './client';

export { ApiClient, ApiError, type AuthMode, type ClientOptions } from './client';

/**
 * Фасад API /v1.
 *
 * Каждый метод знает свою схему ответа, поэтому расхождение сервера с
 * контрактом обнаруживается сразу, а не превращается в `undefined` где-то
 * в глубине интерфейса.
 *
 * Использовать этот фасад НЕ обязательно: новый фронтенд может обращаться к
 * `/v1` как угодно, ориентируясь на `GET /v1/openapi.json`
 * (docs/frontend-replacement-guide.md).
 */
export class UnicornApi {
  readonly http: ApiClient;

  constructor(options: ClientOptions) {
    this.http = new ApiClient(options);
  }

  // ------------------------------------------------------------- публичное
  readonly health = () => this.http.request({ path: '/health', schema: HealthSchema });

  /** Тарифы и условия вознаграждения — без авторизации (радикальная прозрачность). */
  readonly pricing = () => this.http.request({ path: '/pricing', schema: PricingSchema });

  /**
   * Справочник направлений.
   *
   * Сервер отдаёт список в конверте `{ items }`, и клиент обязан разбирать
   * именно его. Раньше здесь стоял голый массив: метод падал при каждом вызове,
   * и это никем не замечалось, пока не появился фронтенд, который его вызывает
   * (найдено рендер-проверкой витрины в Ф10).
   */
  readonly taxonomy = () =>
    this.http
      .request({ path: '/taxonomy', schema: z.object({ items: z.array(TaxonomyNodeSchema) }) })
      .then((response) => response.items);

  /** Текущий сезон. `null` — активного сезона нет, и это законный ответ. */
  readonly currentSeason = () =>
    this.http
      .request({
        path: '/seasons/current',
        schema: z.object({ season: SeasonSchema.nullable() }),
      })
      .then((response) => response.season);

  readonly rating = (seasonId: string) =>
    this.http
      .request({
        path: `/seasons/${seasonId}/rating`,
        schema: z.object({ items: z.array(RatingEntrySchema) }),
      })
      .then((response) => response.items);

  /** Публичный каталог тизеров. Полные карточки — только по подписке. */
  readonly catalog = (filter: CatalogFilter & { cursor?: string; limit?: number } = {}) =>
    this.http.request({
      path: '/catalog',
      query: filter as Record<string, string | number | undefined>,
      schema: pageResponseSchema(ProjectTeaserSchema),
    });

  // ------------------------------------------------------------- аутентификация
  readonly auth = {
    register: (body: RegisterRequest) =>
      this.http.request({
        method: 'POST',
        path: '/auth/register',
        body,
        schema: AuthSessionSchema,
      }),

    login: (body: LoginRequest) =>
      this.http.request({ method: 'POST', path: '/auth/login', body, schema: AuthSessionSchema }),

    logout: () => this.http.request<void>({ method: 'POST', path: '/auth/logout' }),

    me: () => this.http.request({ path: '/auth/me', schema: CurrentUserSchema }),

    /** Акцепт новых версий документов при `reacceptRequired`. */
    acceptConsents: (consents: { kind: string; version: string; locale: string }[]) =>
      this.http.request({
        method: 'POST',
        path: '/auth/consents',
        body: { consents },
        schema: AuthSessionSchema,
      }),
  };

  // ------------------------------------------------------------------- KYC
  readonly kyc = {
    start: (body: unknown) =>
      this.http.request({ method: 'POST', path: '/kyc/verifications', body }),
    status: () => this.http.request({ path: '/kyc/verifications' }),
    createEntity: (body: CreateEntityRequest) =>
      this.http.request({ method: 'POST', path: '/kyc/entities', body }),
  };

  // -------------------------------------------------------------- проекты
  readonly projects = {
    list: (query: { cursor?: string; limit?: number } = {}) =>
      this.http.request({
        path: '/projects',
        query,
        schema: pageResponseSchema(ProjectFullSchema),
      }),

    get: (id: string) => this.http.request({ path: `/projects/${id}`, schema: ProjectFullSchema }),

    create: (body: CreateProjectRequest) =>
      this.http.request({
        method: 'POST',
        path: '/projects',
        body,
        schema: ProjectFullSchema,
        idempotencyKey: uuidv7(),
      }),

    update: (id: string, body: UpdateProjectRequest) =>
      this.http.request({
        method: 'PATCH',
        path: `/projects/${id}`,
        body,
        schema: ProjectFullSchema,
      }),

    /** Публикация листинга. Сервер проверит подписку и соответствие тарифа. */
    publish: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/listing`,
        schema: ProjectFullSchema,
        idempotencyKey: uuidv7(),
      }),

    unpublish: (id: string) =>
      this.http.request({ method: 'DELETE', path: `/projects/${id}/listing` }),

    requestUpload: (body: RequestUpload) =>
      this.http.request({ method: 'POST', path: '/projects/materials/upload', body }),

    addProductLink: (body: AddProductLink) =>
      this.http.request({ method: 'POST', path: '/projects/materials/link', body }),

    passport: (id: string) =>
      this.http.request({
        path: `/projects/${id}/passport`,
        schema: InvestmentPassportSchema,
      }),

    askMentor: (body: MentorQuestion) =>
      this.http.request({
        method: 'POST',
        path: '/projects/mentor',
        body,
        schema: MentorAnswerSchema,
      }),
  };

  // -------------------------------------------------------------- биллинг
  readonly billing = {
    subscriptions: () =>
      this.http.request({ path: '/billing/subscriptions', schema: z.array(SubscriptionSchema) }),

    subscribe: (body: CreateSubscriptionRequest) =>
      this.http.request({
        method: 'POST',
        path: '/billing/subscriptions',
        body,
        schema: SubscriptionSchema,
        idempotencyKey: body.idempotencyKey,
      }),

    cancel: (id: string) =>
      this.http.request({ method: 'DELETE', path: `/billing/subscriptions/${id}` }),

    invoices: (query: { cursor?: string; limit?: number } = {}) =>
      this.http.request({
        path: '/billing/invoices',
        query,
        schema: pageResponseSchema(InvoiceSchema),
      }),

    accruals: (query: { cursor?: string; limit?: number } = {}) =>
      this.http.request({
        path: '/billing/accruals',
        query,
        schema: pageResponseSchema(CommissionAccrualSchema),
      }),

    pay: (body: CreatePaymentRequest) =>
      this.http.request({
        method: 'POST',
        path: '/billing/payments',
        body,
        schema: PaymentSchema,
        idempotencyKey: body.idempotencyKey,
      }),
  };

  // ---------------------------------------------------- регулируемые сделки
  readonly investments = {
    offers: (query: { cursor?: string; limit?: number } = {}) =>
      this.http.request({
        path: '/investments/offers',
        query,
        schema: pageResponseSchema(InvestmentOfferSchema),
      }),

    createOffer: (body: CreateOfferRequest) =>
      this.http.request({
        method: 'POST',
        path: '/investments/offers',
        body,
        schema: InvestmentOfferSchema,
        idempotencyKey: body.idempotencyKey,
      }),

    /** Требует step-up MFA. При 403 STEP_UP_REQUIRED — поднять уровень и повторить. */
    acceptOffer: (body: AcceptOfferRequest) =>
      this.http.request({
        method: 'POST',
        path: '/investments/agreements',
        body,
        schema: InvestmentAgreementSchema,
        idempotencyKey: body.idempotencyKey,
      }),

    /** Тоже step-up MFA. */
    signAgreement: (body: SignAgreementRequest) =>
      this.http.request({
        method: 'POST',
        path: `/investments/agreements/${body.agreementId}/signature`,
        body,
        schema: InvestmentAgreementSchema,
        idempotencyKey: body.idempotencyKey,
      }),

    agreements: (query: { cursor?: string; limit?: number } = {}) =>
      this.http.request({
        path: '/investments/agreements',
        query,
        schema: pageResponseSchema(InvestmentAgreementSchema),
      }),

    agreement: (id: string) =>
      this.http.request({
        path: `/investments/agreements/${id}`,
        schema: InvestmentAgreementSchema,
      }),
  };

  // -------------------------------------------------------------- эксперты
  readonly experts = {
    assignments: () =>
      this.http.request({ path: '/experts/assignments', schema: z.array(ExpertAssignmentSchema) }),

    submitReview: (body: SubmitReviewRequest) =>
      this.http.request({
        method: 'POST',
        path: `/experts/assignments/${body.assignmentId}/review`,
        body,
      }),

    declareConflict: (body: { projectId: string; description: string }) =>
      this.http.request({ method: 'POST', path: '/experts/conflicts', body }),
  };

  // ----------------------------------------------------------- уведомления
  readonly notifications = {
    list: (query: { cursor?: string; limit?: number } = {}) =>
      this.http.request({
        path: '/notifications',
        query,
        schema: pageResponseSchema(NotificationSchema),
      }),

    preferences: () => this.http.request({ path: '/notifications/preferences' }),

    updatePreferences: (prefs: NotificationPreference[]) =>
      this.http.request({ method: 'PUT', path: '/notifications/preferences', body: { prefs } }),

    registerDevice: (body: RegisterDeviceRequest) =>
      this.http.request({ method: 'POST', path: '/notifications/devices', body }),
  };

  // ------------------------------------------------------------- согласия
  readonly publication = {
    grant: (body: PublicationConsentRequest) =>
      this.http.request({ method: 'POST', path: '/publication-consents', body }),
    revoke: (id: string) =>
      this.http.request({ method: 'DELETE', path: `/publication-consents/${id}` }),
  };
}

/** Клиент для веб-фронтендов: сессия в httpOnly-cookie + CSRF-токен. */
export function createWebClient(baseUrl: string, csrfToken: string | null = null): UnicornApi {
  return new UnicornApi({ baseUrl, auth: { kind: 'cookie', csrfToken } });
}

/** Клиент для мобильных и сторонних приложений: OAuth PKCE + Bearer. */
export function createBearerClient(baseUrl: string, getToken: () => string | null): UnicornApi {
  return new UnicornApi({ baseUrl, auth: { kind: 'bearer', getToken } });
}

/** Клиент без аутентификации: только публичные эндпоинты. */
export function createPublicClient(baseUrl: string): UnicornApi {
  return new UnicornApi({ baseUrl, auth: { kind: 'none' } });
}
