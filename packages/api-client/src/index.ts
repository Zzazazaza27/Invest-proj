import {
  AcceptedSchema,
  AnalysisRunSchema,
  ApplicationDetailSchema,
  type ChangeFundingRoundBasisRequestSchema,
  type CloseFundingRoundRequestSchema,
  type CreateFundingRoundRequestSchema,
  FundingRoundBasisHistoryEntrySchema,
  FundingRoundDetailSchema,
  FundingRoundSchema,
  PaymentViewSchema,
  MediaUploadTicketSchema,
  MyProfileSchema,
  ChangePasswordResultSchema,
  type MyProfile,
  ProjectMediaSchema,
  ServiceRunAvailabilitySchema,
  ServiceRunViewSchema,
  RoundPurchaseViewSchema,
  RoundQuoteSchema,
  ServiceCountryPolicyVersionSchema,
  ServiceCountrySchema,
  type UpdateFundingRoundRequestSchema,
  type UpdateServiceCountryRequestSchema,
  type ActivateServiceCountryPolicyRequestSchema,
  ApplicationFormVersionSchema,
  ApplicationFormVersionsSchema,
  ApplicationFormViewSchema,
  ApplicationListSchema,
  ProjectLimitsSchema,
  ApplicationPreviewSchema,
  ReadinessConfigVersionSchema,
  TextsResponseSchema,
  AuthSessionSchema,
  FeaturesSchema,
  InvestmentApplicationSchema,
  BusinessEntitySchema,
  CommissionAccrualSchema,
  ConsentTemplateSchema,
  CurrentUserSchema,
  EmailVerificationStatusSchema,
  EntityMemberSchema,
  ExpertAssignmentSchema,
  ExpertHistoryEntrySchema,
  ExpertNoteSchema,
  FavoriteProjectSchema,
  HealthSchema,
  InvestmentAgreementSchema,
  InvestmentOfferSchema,
  InvestmentPassportSchema,
  InvoiceSchema,
  KybVerificationSchema,
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
  PublicViewSchema,
  InvestorViewSchema,
  ProjectAccessEntrySchema,
  ProjectAccessListSchema,
  type ExcludeAccessRequest,
  type GrantAccessRequest,
  ViewPreviewSchema,
  RoundOpenPreviewSchema,
  ApplyDisclosureResultSchema,
  type ApplyDisclosureRequest,
  type OpenFundingRoundRequest,
  type PreviewAudience,
  type SetMaterialVisibilityRequest,
  type SetProjectVisibilityRequest,
  type SubmitApplicationRequest,
  PublicationConsentSchema,
  RatingEntrySchema,
  ReadinessEntrySchema,
  RoadmapSchema,
  SeasonFunnelConfigSchema,
  LandingContentSchema,
  SeasonSchema,
  SeasonStageOccupancySchema,
  SubscriptionSchema,
  SupportMessageSchema,
  SupportTicketDetailSchema,
  SupportTicketSchema,
  TaxonomyNodeSchema,
  UploadTicketSchema,
  UserDeviceSchema,
  pageResponseSchema,
  uuidv7,
  type AcceptOfferRequest,
  type AdvanceProjectStageRequest,
  type AddProductLink,
  type CatalogFilter,
  type CreateApplicationRequest,
  type UpdateApplicationRequest,
  type ApplicationFormConfig,
  type ProjectStage,
  type ReadinessConfig,
  type TextNamespace,
  type AddEntityMemberRequest,
  type CreateEntityRequest,
  type StartKybRequest,
  type CreateOfferRequest,
  type CreatePaymentRequest,
  type CreateProjectRequest,
  type CreateSubscriptionRequest,
  type CreateSupportTicketRequest,
  type LoginRequest,
  type NotificationPreference,
  type PublicationConsentRequest,
  type RegisterDeviceRequest,
  type RegisterRequest,
  type FinalizeMedia,
  type RequestMediaUpload,
  type RequestUpload,
  type UpdateSupportTicketRequest,
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

  /** Public View проекта (5.7.2): тизер плюс ответы, согласованные владельцем, для аудитории сессии. */
  /**
   * Логотип и обложка проекта.
   *
   * Отдаются адреса маршрутов ядра, а не ссылки в хранилище: доступ к
   * изображению проверяется на каждом запросе.
   */
  readonly projectMedia = (id: string) =>
    this.http.request({
      path: `/projects/${id}/media`,
      schema: z.object({ items: z.array(ProjectMediaSchema) }),
    });

  readonly catalogItem = (id: string, locale?: string) =>
    this.http.request({
      path: `/catalog/${id}`,
      query: { locale },
      schema: PublicViewSchema,
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

    /**
     * Действующие версии документов. Публичный маршрут: без него нельзя ни
     * зарегистрироваться, ни выдать согласие — версию акцепта неоткуда взять,
     * а подставленная наугад отвергается сервером (Ф49).
     */
    consentTemplates: (locale = 'ru-RU') =>
      this.http
        .request({
          path: `/auth/consents/templates?locale=${encodeURIComponent(locale)}`,
          schema: z.object({ items: z.array(ConsentTemplateSchema) }),
        })
        .then((response) => response.items),

    /**
     * Запрос ссылки на смену пароля.
     *
     * Ответ ОДИН И ТОТ ЖЕ независимо от того, существует ли адрес: сервер не
     * даёт клиенту способа различить, а клиент — не пытается. Показывать
     * «такого адреса нет» здесь было бы перечислением пользователей.
     */
    passwordForgot: (email: string) =>
      this.http.request({
        method: 'POST',
        path: '/auth/password/forgot',
        body: { email },
        schema: AcceptedSchema,
      }),

    /** Смена пароля по ссылке из письма. Сессию НЕ открывает. */
    passwordReset: (token: string, password: string) =>
      this.http.request({
        method: 'POST',
        path: '/auth/password/reset',
        body: { token, password },
        schema: z.object({ ok: z.literal(true) }),
      }),

    /** Письмо с подтверждением своего адреса. Нужна открытая сессия. */
    requestEmailVerification: () =>
      this.http.request({
        method: 'POST',
        path: '/auth/email/verify/request',
        schema: z.object({ expiresAt: z.string() }),
      }),

    /** Переход по ссылке подтверждения: сессия не нужна. */
    confirmEmail: (token: string) =>
      this.http.request({
        method: 'POST',
        path: '/auth/email/verify/confirm',
        body: { token },
        schema: z.object({ verified: z.literal(true) }),
      }),

    emailVerificationStatus: () =>
      this.http.request({
        path: '/auth/email/verify/status',
        schema: EmailVerificationStatusSchema,
      }),

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

    /**
     * Участник или бенефициар юрлица.
     *
     * Участник — существующий пользователь платформы (`userId`), а не строка с
     * именем: раскрытие бенефициаров имеет смысл только тогда, когда за каждым
     * стоит проверяемое лицо. Служебная консоль до Ф54 слала сюда
     * `{ fullName, role, sharePercent }` — полей с такими именами сервер не
     * принимает вовсе, и операция не могла отработать ни разу.
     */
    addMember: (entityId: string, body: AddEntityMemberRequest) =>
      this.http.request({
        method: 'POST',
        path: `/kyc/entities/${encodeURIComponent(entityId)}/members`,
        body,
        schema: EntityMemberSchema,
      }),

    /** Запустить проверку юрлица. Без неё эмитент не допускается к выпуску. */
    startKyb: (entityId: string, kind: StartKybRequest['kind']) =>
      this.http.request({
        method: 'POST',
        path: `/kyc/entities/${encodeURIComponent(entityId)}/kyb`,
        body: { kind },
        schema: KybVerificationSchema,
      }),
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

    /** Investor View (5.7.2): блоки по разрешениям зрителя — предикат решает состав. */
    investorView: (id: string, locale?: string) =>
      this.http.request({
        path: `/projects/${id}/investor-view`,
        query: { locale },
        schema: InvestorViewSchema,
      }),

    /** Предпросмотр владельца: что увидит аудитория, кто это увидит, что станет видно после «Применить». */
    viewPreview: (id: string, params: { audience?: PreviewAudience; locale?: string } = {}) =>
      this.http.request({
        path: `/projects/${id}/view-preview`,
        query: params,
        schema: ViewPreviewSchema,
      }),

    /** «Кто может видеть проект» (5.7.3): режим с проверками листинга; listing_status — следствие. */
    setVisibility: (id: string, body: SetProjectVisibilityRequest) =>
      this.http.request({
        method: 'PUT',
        path: `/projects/${id}/visibility`,
        body,
        schema: ProjectFullSchema,
        idempotencyKey: uuidv7(),
      }),

    /** «Применить новые условия раскрытия» к профилю и (по желанию) незавершённому раунду. */
    applyDisclosure: (id: string, body: ApplyDisclosureRequest) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/disclosure/apply`,
        body,
        schema: ApplyDisclosureResultSchema,
        idempotencyKey: uuidv7(),
      }),

    /**
     * Разрешения выбранных получателей (5.8): список выданного и исключений.
     * Тизера в наборе нет — он следствие любого действующего разрешения.
     */
    access: (id: string) =>
      this.http.request({ path: `/projects/${id}/access`, schema: ProjectAccessListSchema }),

    /** Выдать набор разрешений получателю, названному точным адресом почты. */
    grantAccess: (id: string, body: GrantAccessRequest) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/access/grants`,
        body,
        schema: ProjectAccessEntrySchema,
        idempotencyKey: uuidv7(),
      }),

    /** Закрыть выданный доступ; запись остаётся историей. */
    revokeAccess: (id: string, grantId: string) =>
      this.http.request({ method: 'DELETE', path: `/projects/${id}/access/grants/${grantId}` }),

    /** Исключение: доступ закрыт при любом режиме и любом разрешении. */
    excludeAccess: (id: string, body: ExcludeAccessRequest) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/access/exclusions`,
        body,
        schema: ProjectAccessEntrySchema,
        idempotencyKey: uuidv7(),
      }),

    /** Снять исключение. Разрешения оно не возвращает — они живут отдельно. */
    revokeExclusion: (id: string, exclusionId: string) =>
      this.http.request({
        method: 'DELETE',
        path: `/projects/${id}/access/exclusions/${exclusionId}`,
      }),

    /** Отметка материала: показывать допущенным инвесторам или только команде. */
    setMaterialVisibility: (id: string, materialId: string, body: SetMaterialVisibilityRequest) =>
      this.http.request({
        method: 'PUT',
        path: `/projects/${id}/materials/${materialId}/visibility`,
        body,
        schema: ProjectMaterialSchema,
        idempotencyKey: uuidv7(),
      }),

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
    /** Логотип и обложка проекта (7.2). */
    media: (id: string) =>
      this.http.request({
        path: `/projects/${id}/media`,
        schema: z.object({ items: z.array(ProjectMediaSchema) }),
      }),

    requestMediaUpload: (id: string, body: RequestMediaUpload) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/media/upload`,
        body,
        schema: MediaUploadTicketSchema,
        idempotencyKey: uuidv7(),
      }),

    /**
     * Подтвердить загрузку и задать кадрирование.
     *
     * До этого вызова платформа файл не разбирала: отказ по формату, размеру
     * или размерам изображения приходит именно здесь.
     */
    finalizeMedia: (id: string, kind: 'logo' | 'cover', body: FinalizeMedia) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/media/${kind}/finalize`,
        body,
        schema: ProjectMediaSchema,
      }),

    removeMedia: (id: string, kind: 'logo' | 'cover') =>
      this.http.request({
        method: 'DELETE',
        path: `/projects/${id}/media/${kind}`,
        schema: z.object({ removed: z.string() }),
      }),

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
  // -------------------------------------------------------------- заявки
  /**
   * Инвестиционные заявки проекта (M071). Заявка отделена от проекта: у
   * проекта их может быть несколько, у каждой — свои версии и свой архив.
   * Черновик свободен; что мешает подаче — в `submission.missing`.
   */
  /** Лимит проектов аккаунта (0 — безлимит) и его происхождение. */
  readonly projectLimits = () =>
    this.http.request({ path: '/projects/limits', schema: ProjectLimitsSchema });

  readonly applications = {
    list: (projectId: string) =>
      this.http.request({
        path: `/projects/${projectId}/applications`,
        schema: ApplicationListSchema,
      }),

    create: (projectId: string, body: CreateApplicationRequest = {}) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${projectId}/applications`,
        body,
        schema: InvestmentApplicationSchema,
        idempotencyKey: uuidv7(),
      }),

    /** Заявка с условиями подачи и готовностью (процент, разделы, недостающее). */
    get: (id: string) =>
      this.http.request({ path: `/applications/${id}`, schema: ApplicationDetailSchema }),

    /** Автосохранение: частичное тело, `null` очищает поле; ответы проверяются по форме версии. */
    update: (id: string, body: UpdateApplicationRequest, opts: { keepalive?: boolean } = {}) =>
      this.http.request({
        method: 'PATCH',
        path: `/applications/${id}`,
        body,
        schema: ApplicationDetailSchema,
        keepalive: opts.keepalive,
      }),

    archive: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/applications/${id}/archive`,
        schema: InvestmentApplicationSchema,
      }),

    /**
     * Подача без сезона: неизменяемый снимок версии заявки и согласие владельца
     * показывать его (5.7.3). `activeFormVersion` — версия из предпросмотра;
     * смена условий между предпросмотром и подачей — 409.
     */
    submit: (id: string, body: SubmitApplicationRequest) =>
      this.http.request({
        method: 'POST',
        path: `/applications/${id}/submit`,
        body,
        schema: ProjectVersionSchema,
        idempotencyKey: uuidv7(),
      }),

    /**
     * Форма заявки по ЕЁ версии конфигурации и стадии: разделы, вопросы с
     * состояниями и текстами (fallback — ru-RU). Черновик живёт на своей
     * версии, поэтому форма не меняется после публикации новой.
     */
    form: (id: string, locale?: string) =>
      this.http.request({
        path: `/applications/${id}/form${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`,
        schema: ApplicationFormViewSchema,
      }),

    /** Сводка «как увидит инвестор»: только public / investors, только заполненное. */
    /** Предпросмотр для аудитории: `public` — аноним, `investors` — инвестор с доступом. */
    preview: (id: string, opts: { locale?: string; audience?: 'public' | 'investors' } = {}) => {
      const params = new URLSearchParams();
      if (opts.locale) params.set('locale', opts.locale);
      if (opts.audience) params.set('audience', opts.audience);
      const qs = params.toString();
      return this.http.request({
        path: `/applications/${id}/preview${qs ? `?${qs}` : ''}`,
        schema: ApplicationPreviewSchema,
      });
    },
  };

  /**
   * Конфигурация вопросов заявки — админка (план 0.2 §0в.4): черновик,
   * предпросмотр, публикация, история, откат.
   */
  readonly applicationForms = {
    list: () =>
      this.http.request({
        path: '/admin/application-forms',
        schema: ApplicationFormVersionsSchema,
      }),

    draft: () =>
      this.http.request({
        path: '/admin/application-forms/draft',
        schema: ApplicationFormVersionSchema,
      }),

    version: (version: number) =>
      this.http.request({
        path: `/admin/application-forms/${version}`,
        schema: ApplicationFormVersionSchema,
      }),

    /** Сохранить черновик целиком; сервер проверяет схему и правила эволюции. */
    saveDraft: (config: ApplicationFormConfig) =>
      this.http.request({
        method: 'PUT',
        path: '/admin/application-forms/draft',
        body: { config },
        schema: ApplicationFormVersionSchema,
      }),

    preview: (stage: ProjectStage, locale?: string) =>
      this.http.request({
        path:
          `/admin/application-forms/draft/preview?stage=${stage}` +
          (locale ? `&locale=${encodeURIComponent(locale)}` : ''),
        schema: ApplicationFormViewSchema,
      }),

    publish: (reason: string) =>
      this.http.request({
        method: 'POST',
        path: '/admin/application-forms/draft/publish',
        body: { reason },
        schema: ApplicationFormVersionSchema,
        idempotencyKey: uuidv7(),
      }),

    /** Откат или возврат: активировать ранее опубликованную версию. */
    activate: (version: number, reason: string) =>
      this.http.request({
        method: 'POST',
        path: `/admin/application-forms/${version}/activate`,
        body: { reason },
        schema: ApplicationFormVersionSchema,
        idempotencyKey: uuidv7(),
      }),
  };

  /** Словарь и ЧАВО на языке — публично, с fallback на ru-RU (план 0.2 §2.6). */
  readonly texts = (namespace: TextNamespace, locale = 'ru-RU') =>
    this.http.request({
      path: `/content/texts?namespace=${namespace}&locale=${encodeURIComponent(locale)}`,
      schema: TextsResponseSchema,
    });

  /** Веса готовности — отдельная версия и активация (план 0.2 §2.7). */
  /** Раунды привлечения (план 0.2 §0г): черновик, изменение, переходы, основание. */
  readonly rounds = {
    list: (projectId: string) =>
      this.http.request({
        path: `/projects/${projectId}/rounds`,
        schema: z.object({ items: z.array(FundingRoundSchema) }),
      }),
    /** Черновик раунда; повторный вызов возвращает существующий. */
    create: (projectId: string, body: z.input<typeof CreateFundingRoundRequestSchema> = {}) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${projectId}/rounds`,
        body,
        schema: FundingRoundDetailSchema,
        idempotencyKey: uuidv7(),
      }),
    get: (id: string) =>
      this.http.request({ path: `/rounds/${id}`, schema: FundingRoundDetailSchema }),
    update: (
      id: string,
      body: z.input<typeof UpdateFundingRoundRequestSchema>,
      opts: { keepalive?: boolean } = {},
    ) =>
      this.http.request({
        method: 'PATCH',
        path: `/rounds/${id}`,
        body,
        schema: FundingRoundDetailSchema,
        keepalive: opts.keepalive,
      }),
    /** Открытие с подтверждением версии условий раскрытия из `openPreview` (5.7.3). */
    open: (id: string, body: OpenFundingRoundRequest) =>
      this.http.request({
        method: 'POST',
        path: `/rounds/${id}/open`,
        body,
        schema: FundingRoundDetailSchema,
        idempotencyKey: uuidv7(),
      }),
    pause: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/rounds/${id}/pause`,
        schema: FundingRoundDetailSchema,
        idempotencyKey: uuidv7(),
      }),
    resume: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/rounds/${id}/resume`,
        schema: FundingRoundDetailSchema,
        idempotencyKey: uuidv7(),
      }),
    close: (id: string, body: z.input<typeof CloseFundingRoundRequestSchema>) =>
      this.http.request({
        method: 'POST',
        path: `/rounds/${id}/close`,
        body,
        schema: FundingRoundDetailSchema,
        idempotencyKey: uuidv7(),
      }),
    cancel: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/rounds/${id}/cancel`,
        schema: FundingRoundDetailSchema,
        idempotencyKey: uuidv7(),
      }),
    changeBasis: (id: string, body: z.input<typeof ChangeFundingRoundBasisRequestSchema>) =>
      this.http.request({
        method: 'PUT',
        path: `/rounds/${id}/basis`,
        body,
        schema: FundingRoundDetailSchema,
      }),
    basisHistory: (id: string) =>
      this.http.request({
        path: `/rounds/${id}/basis-history`,
        schema: z.object({ items: z.array(FundingRoundBasisHistoryEntrySchema) }),
      }),

    /** Предпросмотр перед открытием: что увидят аноним и инвестор по активной версии условий. */
    openPreview: (id: string) =>
      this.http.request({ path: `/rounds/${id}/open-preview`, schema: RoundOpenPreviewSchema }),

    /**
     * Во что обойдётся запуск (5.9.2). Только чтение: ничего не покупается.
     * Выбор основателя — более полный пакет и докупаемые услуги — передаётся
     * параметрами, потому что хранить незавершённый выбор пока негде.
     */
    /** Сохранить выбор пакета и услуг: черновик намерения, не покупка. */
    saveSelection: (id: string, selection: { packageCode?: string; serviceCodes?: string[] }) =>
      this.http.request({
        method: 'PUT',
        path: `/rounds/${id}/package-selection`,
        body: { packageCode: selection.packageCode, serviceCodes: selection.serviceCodes ?? [] },
        schema: z.object({
          packageCode: z.string().optional(),
          serviceCodes: z.array(z.string()),
        }),
      }),

    /** Оформить покупку по сохранённому выбору. Сумма берётся из расчёта. */
    createPurchase: (id: string) =>
      this.http.request({
        method: 'POST',
        path: `/rounds/${id}/purchase`,
        schema: RoundPurchaseViewSchema,
        idempotencyKey: uuidv7(),
      }),

    purchase: (id: string) =>
      this.http.request({
        path: `/rounds/${id}/purchase`,
        schema: z.union([RoundPurchaseViewSchema, z.object({ purchase: z.null() })]),
      }),

    /**
     * Начать оплату покупки у оператора платежей.
     *
     * Суммы в запросе нет: её назначает сервер по покупке. Ответ содержит
     * адрес страницы оплаты — переход по нему оплату НЕ подтверждает.
     */
    startPayment: (purchaseId: string, returnUrl?: string) =>
      this.http.request({
        method: 'POST',
        path: `/billing/purchases/${purchaseId}/payment`,
        body: returnUrl ? { returnUrl } : {},
        schema: PaymentViewSchema,
        idempotencyKey: uuidv7(),
      }),

    /** Состояние платежа. Чтение: возврат со страницы оплаты ничего не меняет. */
    payment: (purchaseId: string) =>
      this.http.request({
        path: `/billing/purchases/${purchaseId}/payment`,
        schema: z.object({ payment: PaymentViewSchema.nullable() }),
      }),

    /** Что по покупке можно запустить и что мешает (услуги платформы). */
    serviceRuns: (purchaseId: string) =>
      this.http.request({
        path: `/billing/purchases/${purchaseId}/service-runs`,
        schema: z.object({ items: z.array(ServiceRunAvailabilitySchema) }),
      }),

    /** Запустить разбор по позиции. Повтор не создаёт второго исполнения. */
    startServiceRun: (itemId: string) =>
      this.http.request({
        method: 'POST',
        path: `/billing/purchases/items/${itemId}/run`,
        schema: ServiceRunViewSchema,
        idempotencyKey: uuidv7(),
      }),

    quote: (id: string, selection: { packageCode?: string; serviceCodes?: string[] } = {}) => {
      const query = new URLSearchParams();
      if (selection.packageCode) query.set('packageCode', selection.packageCode);
      if (selection.serviceCodes?.length)
        query.set('serviceCodes', selection.serviceCodes.join(','));
      const suffix = query.toString();
      return this.http.request({
        path: `/rounds/${id}/quote${suffix ? `?${suffix}` : ''}`,
        schema: RoundQuoteSchema,
      });
    },
  };

  /** Страны обслуживания: список публичен, условия — вошедшему; выбор — за аккаунтом. */
  readonly serviceCountries = {
    list: () =>
      this.http.request({
        path: '/service-countries',
        schema: z.object({ items: z.array(ServiceCountrySchema) }),
      }),
    policy: (code: string) =>
      this.http.request({
        path: `/service-countries/${encodeURIComponent(code)}/policy`,
        schema: ServiceCountryPolicyVersionSchema,
      }),
    setMine: (code: string) =>
      this.http.request({
        method: 'PUT',
        path: '/me/service-country',
        body: { code },
        schema: z.object({ serviceCountry: z.string() }),
      }),
    admin: {
      create: (code: string) =>
        this.http.request({
          method: 'POST',
          path: '/admin/service-countries',
          body: { code },
          schema: ServiceCountrySchema,
          idempotencyKey: uuidv7(),
        }),
      list: () =>
        this.http.request({
          path: '/admin/service-countries',
          schema: z.object({ items: z.array(ServiceCountrySchema) }),
        }),
      update: (code: string, body: z.input<typeof UpdateServiceCountryRequestSchema>) =>
        this.http.request({
          method: 'PATCH',
          path: `/admin/service-countries/${encodeURIComponent(code)}`,
          body,
          schema: ServiceCountrySchema,
        }),
      policies: (code: string) =>
        this.http.request({
          path: `/admin/service-countries/${encodeURIComponent(code)}/policies`,
          schema: z.object({ items: z.array(ServiceCountryPolicyVersionSchema) }),
        }),
      activatePolicy: (
        code: string,
        body: z.input<typeof ActivateServiceCountryPolicyRequestSchema>,
      ) =>
        this.http.request({
          method: 'POST',
          path: `/admin/service-countries/${encodeURIComponent(code)}/policies`,
          body,
          schema: ServiceCountryPolicyVersionSchema,
          idempotencyKey: uuidv7(),
        }),
    },
  };

  readonly readinessConfigs = {
    list: () =>
      this.http
        .request({
          path: '/admin/readiness-configs',
          schema: z.object({ items: z.array(ReadinessConfigVersionSchema) }),
        })
        .then((response) => response.items),

    activate: (config: ReadinessConfig, reason: string) =>
      this.http.request({
        method: 'POST',
        path: '/admin/readiness-configs',
        body: { config, reason },
        schema: ReadinessConfigVersionSchema,
        idempotencyKey: uuidv7(),
      }),
  };

  /** Публичные флаги интерфейса: барьер подписки, версия кабинета основателя. */
  readonly features = () => this.http.request({ path: '/features', schema: FeaturesSchema });

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

    /**
     * Пересмотр уже поданной рецензии. Идентификатор назначения — в пути, а
     * не в теле: два источника правды об одном не нужны.
     */
    reviseReview: (assignmentId: string, body: Omit<SubmitReviewRequest, 'assignmentId'>) =>
      this.http.request({
        method: 'PATCH',
        path: `/experts/assignments/${encodeURIComponent(assignmentId)}/review`,
        body,
      }),

    notes: (assignmentId: string) =>
      this.http
        .request({
          path: `/experts/assignments/${encodeURIComponent(assignmentId)}/notes`,
          schema: z.object({ items: z.array(ExpertNoteSchema) }),
        })
        .then((response) => response.items),

    addNote: (assignmentId: string, body: string) =>
      this.http.request({
        method: 'POST',
        path: `/experts/assignments/${encodeURIComponent(assignmentId)}/notes`,
        body: { body },
        schema: ExpertNoteSchema,
      }),

    /** История рассмотрения из журнала событий. */
    history: (assignmentId: string) =>
      this.http
        .request({
          path: `/experts/assignments/${encodeURIComponent(assignmentId)}/history`,
          schema: z.object({ items: z.array(ExpertHistoryEntrySchema) }),
        })
        .then((response) => response.items),
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

  // ------------------------------------------------------------- избранное
  /**
   * Избранные проекты инвестора.
   *
   * PUT и DELETE, а не «переключить»: обе операции идемпотентны, и повтор при
   * обрыве связи приводит к тому же состоянию. Переключатель на повторе дал бы
   * противоположный результат.
   */
  readonly favorites = {
    list: () =>
      this.http
        .request({
          path: '/investor/favorites',
          schema: z.object({ items: z.array(FavoriteProjectSchema) }),
        })
        .then((response) => response.items),

    /** Только идентификаторы — каталог отмечает карточки одним запросом. */
    ids: () =>
      this.http
        .request({
          path: '/investor/favorites/ids',
          schema: z.object({ items: z.array(z.string()) }),
        })
        .then((response) => response.items),

    add: (projectId: string) =>
      this.http.request({
        method: 'PUT',
        path: `/investor/favorites/${encodeURIComponent(projectId)}`,
        schema: z.object({ favorited: z.boolean() }),
      }),

    remove: (projectId: string) =>
      this.http.request({
        method: 'DELETE',
        path: `/investor/favorites/${encodeURIComponent(projectId)}`,
        schema: z.object({ favorited: z.boolean() }),
      }),
  };

  // -------------------------------------------------------------- поддержка
  /**
   * Обращения в поддержку и сообщения об ошибках — одна сущность, различает
   * `kind`. Отдельного клиента «баг-репортов» нет намеренно: два клиента к
   * одному маршруту расходятся так же, как расходились четыре копии экрана.
   */
  readonly support = {
    /** Свои обращения; сотруднику поддержки политика БД отдаёт все. */
    list: (query: { limit?: number } = {}) =>
      this.http
        .request({
          path: '/support/tickets',
          query,
          schema: z.object({ items: z.array(SupportTicketSchema) }),
        })
        .then((response) => response.items),

    detail: (id: string) =>
      this.http.request({
        path: `/support/tickets/${encodeURIComponent(id)}`,
        schema: SupportTicketDetailSchema,
      }),

    open: (body: CreateSupportTicketRequest) =>
      this.http.request({
        method: 'POST',
        path: '/support/tickets',
        body,
        schema: SupportTicketDetailSchema,
      }),

    reply: (id: string, body: string) =>
      this.http.request({
        method: 'POST',
        path: `/support/tickets/${encodeURIComponent(id)}/messages`,
        body: { body },
        schema: SupportMessageSchema,
      }),

    /** Взять в работу и закрыть. Право проверяет сервер, не клиент. */
    update: (id: string, body: UpdateSupportTicketRequest) =>
      this.http.request({
        method: 'PATCH',
        path: `/support/tickets/${encodeURIComponent(id)}`,
        body,
        schema: SupportTicketDetailSchema,
      }),
  };

  // ------------------------------------------------------------- согласия
  /**
   * Согласия на публичный контур.
   *
   * До Ф50 этих маршрутов в ядре не существовало: клиент их звал, сервер
   * отвечал 404. Расхождение нашёл прогон консоли, а не чтение кода — поэтому
   * ответы здесь разбираются схемой, а не остаются `unknown`.
   */
  readonly publication = {
    list: (projectId?: string) =>
      this.http
        .request({
          path: projectId
            ? `/publication-consents?projectId=${encodeURIComponent(projectId)}`
            : '/publication-consents',
          schema: z.object({ items: z.array(PublicationConsentSchema) }),
        })
        .then((response) => response.items),

    grant: (body: PublicationConsentRequest) =>
      this.http.request({
        method: 'POST',
        path: '/publication-consents',
        body,
        schema: PublicationConsentSchema,
      }),

    /** Отзыв. Строка согласия остаётся — отменяется разрешение, не факт акцепта. */
    revoke: (id: string) =>
      this.http.request({
        method: 'DELETE',
        path: `/publication-consents/${encodeURIComponent(id)}`,
        schema: PublicationConsentSchema,
      }),
  };

  /**
   * «Мой профиль» — то, чем человек распоряжается сам.
   *
   * Группа общая для всех кабинетов: профиль один, и расходиться клиентам
   * здесь нельзя. Экран живёт в `@unicorn/cabinet` и получает эти методы
   * портом — сам он в сеть не ходит.
   */
  readonly profile = {
    me: () => this.http.request({ path: '/me/profile', schema: MyProfileSchema }),

    updateName: (displayName: string) =>
      this.http.request({
        method: 'PATCH',
        path: '/me/profile',
        body: { displayName },
        schema: MyProfileSchema,
      }),

    /**
     * Смена пароля. Ответ подтверждает то, что произойдёт с сессиями: они
     * закрыты все, включая текущую, и клиент обязан увести человека на вход.
     */
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      this.http.request({
        method: 'POST',
        path: '/me/password',
        body,
        schema: ChangePasswordResultSchema,
      }),

    removeAvatar: () =>
      this.http.request({ method: 'DELETE', path: '/me/avatar', schema: MyProfileSchema }),

    /**
     * Загрузка аватара целиком: билет → прямая отправка в хранилище →
     * подтверждение.
     *
     * Средний шаг идёт МИМО ядра: тело запроса к API ограничено мегабайтом, и
     * поднимать предел ради картинок значило бы открыть его для всего
     * остального. Поэтому байты уходят в хранилище по подписанной форме, а
     * ядро потом разбирает загруженное и собирает размеры.
     */
    uploadAvatar: async (file: File): Promise<MyProfile> => {
      const ticket = await this.http.request({
        method: 'POST',
        path: '/me/avatar/upload',
        body: { contentType: file.type, sizeBytes: file.size },
        schema: MediaUploadTicketSchema,
      });
      const form = new FormData();
      for (const [key, value] of Object.entries(ticket.formFields)) form.append(key, value);
      form.append('file', file);
      // Предел ожидания обязателен: отправка идёт напрямую в хранилище, мимо
      // ядра и его таймаутов. Минута на 4 МБ — с большим запасом даже для
      // медленной сети, и всё же конечна.
      const uploaded = await fetch(ticket.uploadUrl, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!uploaded.ok) {
        throw new Error(`Хранилище не приняло файл: HTTP ${uploaded.status}`);
      }
      return this.http.request({
        method: 'POST',
        path: '/me/avatar/finalize',
        schema: MyProfileSchema,
      });
    },
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
