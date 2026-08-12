import {
  AnalysisRunSchema,
  AuthSessionSchema,
  BusinessEntitySchema,
  CommissionAccrualSchema,
  CurrentUserSchema,
  ExpertAssignmentSchema,
  HealthSchema,
  InvestmentAgreementSchema,
  InvestmentOfferSchema,
  InvestmentPassportSchema,
  InvoiceSchema,
  KycVerificationSchema,
  LogoutResultSchema,
  NotificationPreferenceSchema,
  NotificationSchema,
  PaymentSchema,
  PricingSchema,
  ProjectFullSchema,
  ProjectMaterialSchema,
  ProjectStageChangeSchema,
  ProjectSummarySchema,
  ProjectVersionSchema,
  ProjectTeaserSchema,
  RatingEntrySchema,
  ReadinessEntrySchema,
  RoadmapSchema,
  SeasonFunnelConfigSchema,
  LandingContentSchema,
  SeasonSchema,
  SeasonStageOccupancySchema,
  SubscriptionSchema,
  TaxonomyNodeSchema,
  UploadTicketSchema,
  UserDeviceSchema,
  pageResponseSchema,
  uuidv7,
  type AcceptOfferRequest,
  type AdvanceProjectStageRequest,
  type AddProductLink,
  type CatalogFilter,
  type CreateEntityRequest,
  type CreateOfferRequest,
  type CreatePaymentRequest,
  type CreateProjectRequest,
  type CreateSubscriptionRequest,
  type LoginRequest,
  type NotificationPreference,
  type PublicationConsentRequest,
  type RegisterDeviceRequest,
  type RegisterRequest,
  type RequestUpload,
  type SeasonFunnelConfig,
  type SignAgreementRequest,
  type StartKycRequest,
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

  /**
   * Контент публичной витрины: тексты и баннеры.
   *
   * Пустой список — законный ответ: он означает, что администратор ещё ничего
   * не опубликовал. Витрина обязана оставаться читаемой и в этом случае, а не
   * показывать пустые места.
   */
  readonly landingContent = (locale = 'ru-RU') =>
    this.http
      .request({
        path: `/content/landing?locale=${encodeURIComponent(locale)}`,
        schema: LandingContentSchema,
      })
      .then((response) => response.blocks);

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

  /**
   * Отбор внутри сезона — действия организатора: конфигурация воронки и
   * перевод проектов по этапам.
   */
  readonly seasons = {
    funnel: (seasonId: string) =>
      this.http
        .request({
          path: `/seasons/${seasonId}/funnel`,
          schema: z.object({ items: z.array(SeasonStageOccupancySchema) }),
        })
        .then((response) => response.items),

    setFunnel: (seasonId: string, body: SeasonFunnelConfig) =>
      this.http.request({
        method: 'POST',
        path: `/seasons/${seasonId}/funnel`,
        body,
        schema: SeasonFunnelConfigSchema,
      }),

    advanceStage: (seasonId: string, projectId: string, body: AdvanceProjectStageRequest) =>
      this.http.request({
        method: 'POST',
        path: `/seasons/${seasonId}/projects/${projectId}/stage`,
        body,
        schema: ProjectStageChangeSchema,
      }),
  };

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

    /**
     * Выход. Сервер отзывает ИМЕННО этот токен, а не все сессии пользователя.
     *
     * `tokenRevoked: false` означает, что у токена нет идентификатора (внешний
     * IdP без claim `jti`) и сессия закрыта только удалением cookie. Поле не
     * декоративное: интерфейсу нельзя обещать «вышли везде», когда отозвать
     * было нечего.
     */
    logout: () =>
      this.http.request({ method: 'POST', path: '/auth/logout', schema: LogoutResultSchema }),

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
    /**
     * Начать проверку. Схема ответа объявлена: без неё метод возвращал `unknown`,
     * и расхождение с сервером обнаруживалось бы уже в интерфейсе.
     */
    start: (body: StartKycRequest) =>
      this.http.request({
        method: 'POST',
        path: '/kyc/verifications',
        body,
        schema: KycVerificationSchema,
      }),

    /** Свои проверки. Сервер отдаёт конверт `{ items }`. */
    status: () =>
      this.http
        .request({
          path: '/kyc/verifications',
          schema: z.object({ items: z.array(KycVerificationSchema) }),
        })
        .then((response) => response.items),

    createEntity: (body: CreateEntityRequest) =>
      this.http.request({
        method: 'POST',
        path: '/kyc/entities',
        body,
        schema: BusinessEntitySchema,
      }),

    entities: () =>
      this.http
        .request({
          path: '/kyc/entities',
          schema: z.object({ items: z.array(BusinessEntitySchema) }),
        })
        .then((response) => response.items),
  };

  // -------------------------------------------------------------- проекты
  readonly projects = {
    /**
     * Свои проекты. Список НЕ постраничный и отдаёт краткую форму: у одного
     * основателя их единицы, и курсор здесь был бы усложнением без пользы.
     * Раньше клиент ждал страницу полных карточек — метод падал на разборе
     * ответа (найдено рендер-проверкой кабинета в Ф10b).
     */
    list: () =>
      this.http
        .request({ path: '/projects', schema: z.object({ items: z.array(ProjectSummarySchema) }) })
        .then((response) => response.items),

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

    /** Материалы проекта. Видимость решает сервер: владелец, админ, рецензент. */
    materials: (id: string) =>
      this.http
        .request({
          path: `/projects/${id}/materials`,
          schema: z.object({ items: z.array(ProjectMaterialSchema) }),
        })
        .then((response) => response.items),

    /** История подач заявки — версии-снимки, на которые ссылается экспертиза. */
    versions: (id: string) =>
      this.http
        .request({
          path: `/projects/${id}/versions`,
          schema: z.object({ items: z.array(ProjectVersionSchema) }),
        })
        .then((response) => response.items),

    // Адресат берётся из пути: маршруты сервера — `/projects/:id/materials/*`.
    // Клиент до этого звал `/projects/materials/upload`, где `materials`
    // подставлялось в `:id` и запрос падал на разборе UUID.
    requestUpload: (id: string, body: RequestUpload) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/materials/upload`,
        body,
        schema: UploadTicketSchema,
      }),

    /**
     * Подтверждение загрузки после отправки файла в хранилище. Сервер проверяет
     * наличие объекта сам: «я загрузил» от клиента доказательством не является.
     */
    finalizeUpload: (id: string, materialId: string) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/materials/${materialId}/finalize`,
        schema: ProjectMaterialSchema,
      }),

    addProductLink: (id: string, body: AddProductLink) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/materials/link`,
        body,
        schema: ProjectMaterialSchema,
      }),

    /**
     * Подача заявки в сезон. Создаёт неизменяемый снимок версии: именно он, а
     * не текущее состояние проекта, идёт на экспертизу.
     */
    submit: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/submit`,
        // Возвращается сам снимок версии, а не `{ version }`: поле называется
        // versionNo, и придуманная форма ответа падала бы на разборе.
        schema: ProjectVersionSchema,
        idempotencyKey: uuidv7(),
      }),

    /** Прогон анализа. Возвращает результат вместе с признаком, считала ли его модель. */
    runAnalysis: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/analysis`,
        schema: AnalysisRunSchema,
      }),

    readiness: (id: string) =>
      this.http
        .request({
          path: `/projects/${id}/readiness`,
          schema: z.object({ items: z.array(ReadinessEntrySchema) }),
        })
        .then((response) => response.items),

    roadmap: (id: string) =>
      this.http.request({ path: `/projects/${id}/roadmap`, schema: RoadmapSchema.nullable() }),

    passport: (id: string) =>
      this.http.request({
        path: `/projects/${id}/passport`,
        schema: InvestmentPassportSchema,
      }),

    // askMentor удалён: маршрута `/projects/mentor` на сервере нет. AI Mentor
    // выключен до появления eval-гейта (TODO.md), а метод, компилирующийся, но
    // падающий при вызове, обещает контракт, которого не существует.
  };

  // -------------------------------------------------------------- биллинг
  readonly billing = {
    /** Свои подписки. Сервер отдаёт конверт `{ items }`, а не голый массив. */
    subscriptions: () =>
      this.http
        .request({
          path: '/billing/subscriptions',
          schema: z.object({ items: z.array(SubscriptionSchema) }),
        })
        .then((response) => response.items),

    subscribe: (body: CreateSubscriptionRequest) =>
      this.http.request({
        method: 'POST',
        path: '/billing/subscriptions',
        body,
        schema: SubscriptionSchema,
        idempotencyKey: body.idempotencyKey,
      }),

    cancel: (id: string) =>
      this.http.request({ method: 'POST', path: `/billing/subscriptions/${id}/cancel` }),

    /**
     * Свои счета. Пустой список законен: счета выставляются вместе с PDF, а
     * генератора PDF пока нет — маршрут при этом настоящий, не 404.
     */
    invoices: () =>
      this.http
        .request({ path: '/billing/invoices', schema: z.object({ items: z.array(InvoiceSchema) }) })
        .then((response) => response.items),

    /** Начисления вознаграждения по своим сделкам. */
    accruals: () =>
      this.http
        .request({
          path: '/billing/accruals',
          schema: z.object({ items: z.array(CommissionAccrualSchema) }),
        })
        .then((response) => response.items),

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
    /** Свои назначения. Конверт `{ items }`, как и у остальных списков. */
    assignments: () =>
      this.http
        .request({
          path: '/experts/assignments',
          schema: z.object({ items: z.array(ExpertAssignmentSchema) }),
        })
        .then((response) => response.items),

    /**
     * Ответ на назначение. Эксперт принимает его или отказывается — отказ
     * законный исход: рецензент, который не может оценить проект честно,
     * обязан иметь способ это сказать.
     */
    decideAssignment: (assignmentId: string, decision: 'accepted' | 'declined') =>
      this.http.request({
        method: 'POST',
        path: `/experts/assignments/${assignmentId}/decision`,
        body: { decision },
        schema: ExpertAssignmentSchema,
      }),

    /**
     * Рецензия. Маршрут — `POST /experts/reviews` с идентификатором назначения
     * в теле; прежний путь `/assignments/:id/review` на сервере не
     * существовал, и метод падал бы при первом же вызове.
     */
    submitReview: (body: SubmitReviewRequest) =>
      this.http.request({ method: 'POST', path: '/experts/reviews', body }),

    declareConflict: (body: { projectId: string; description: string }) =>
      this.http.request({ method: 'POST', path: '/experts/conflicts', body }),
  };

  // ----------------------------------------------------------- уведомления
  readonly notifications = {
    /** Своя лента. Конверт `{ items }`, без курсора: лента ограничена лимитом. */
    list: (query: { limit?: number } = {}) =>
      this.http
        .request({
          path: '/notifications',
          query,
          schema: z.object({ items: z.array(NotificationSchema) }),
        })
        .then((response) => response.items),

    preferences: () =>
      this.http
        .request({
          path: '/notifications/preferences',
          schema: z.object({ items: z.array(NotificationPreferenceSchema) }),
        })
        .then((response) => response.items),

    /**
     * Обновление настроек. Сервер принимает поле `items`, а не `prefs`:
     * расхождение имени тихо игнорировало бы все переданные настройки.
     */
    updatePreferences: (items: NotificationPreference[]) =>
      this.http
        .request({
          method: 'PUT',
          path: '/notifications/preferences',
          body: { items },
          schema: z.object({ items: z.array(NotificationPreferenceSchema) }),
        })
        .then((response) => response.items),

    devices: () =>
      this.http
        .request({
          path: '/notifications/devices',
          schema: z.object({ items: z.array(UserDeviceSchema) }),
        })
        .then((response) => response.items),

    registerDevice: (body: RegisterDeviceRequest) =>
      this.http.request({
        method: 'POST',
        path: '/notifications/devices',
        body,
        schema: UserDeviceSchema,
      }),

    revokeDevice: (id: string) =>
      this.http.request({ method: 'DELETE', path: `/notifications/devices/${id}` }),
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
