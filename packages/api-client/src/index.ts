import {
  AcceptedSchema,
  MediaUploadTicketSchema,
  ProjectMediaUploadTicketSchema,
  MyProfileSchema,
  TestingSessionListSchema,
  TestingSessionCardSchema,
  CleanupPlanSchema,
  CleanupResultSchema,
  OpenedContextSchema,
  CurrentContextSchema,
  ChangePasswordResultSchema,
  type MyProfile,
  ProjectMediaSchema,
  ServiceCountrySchema,
  type UpdateServiceCountryRequestSchema,
  TextsResponseSchema,
  AuthSessionSchema,
  FeaturesSchema,
  BusinessEntitySchema,
  ConsentTemplateSchema,
  CurrentUserSchema,
  EmailVerificationStatusSchema,
  EntityMemberSchema,
  FavoriteProjectSchema,
  HealthSchema,
  KybVerificationSchema,
  KycVerificationSchema,
  LogoutResultSchema,
  NotificationPreferenceSchema,
  NotificationSchema,
  ProjectFullSchema,
  ProjectMaterialSchema,
  MaterialUploadResultSchema,
  OperationNoticeResultSchema,
  RequestKeyStateSchema,
  type GuardedOperationName,
  UserOperationSchema,
  UserOperationsResponseSchema,
  type OperationKind,
  ProjectSummarySchema,
  ProjectTeaserSchema,
  PublicViewSchema,
  InvestorViewSchema,
  ProjectAccessEntrySchema,
  ProjectAccessListSchema,
  type ExcludeAccessRequest,
  type GrantAccessRequest,
  ViewPreviewSchema,
  type PreviewAudience,
  type SetMaterialVisibilityRequest,
  type SetProjectVisibilityRequest,
  LandingContentSchema,
  SupportMessageSchema,
  SupportTicketDetailSchema,
  SupportTicketSchema,
  TaxonomyNodeSchema,
  UploadTicketSchema,
  UserDeviceSchema,
  pageResponseSchema,
  uuidv7,
  type AddProductLink,
  type CatalogFilter,
  type TextNamespace,
  type AddEntityMemberRequest,
  type CreateEntityRequest,
  type StartKybRequest,
  type CreateProjectRequest,
  type CreateSupportTicketRequest,
  type LoginRequest,
  type NotificationPreference,
  type RegisterDeviceRequest,
  type RegisterRequest,
  type FinalizeMedia,
  type RequestMediaUpload,
  type RequestUpload,
  type UpdateSupportTicketRequest,
  type StartKycRequest,
  type UpdateProjectRequest,
} from '@fifth/contracts';
import { z } from 'zod';
import { ApiClient, type ClientOptions } from './client';

export { ApiClient, ApiError, type AuthMode, type ClientOptions } from './client';
export {
  keyAfterError,
  keyAfterSuccess,
  keyForSend,
  leavesOutcomeOpen,
  type RetryKey,
} from './retry-key';

/**
 * Ключ повтора защищённой операции (2.6): форма создаёт его до первой отправки и передаёт
 * тот же при выяснении неизвестного результата. Без него метод создаёт новый на каждый вызов.
 */
export interface GuardedSend {
  idempotencyKey?: string;
}

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
export class FifthApi {
  readonly http: ApiClient;

  constructor(options: ClientOptions) {
    this.http = new ApiClient(options);
  }

  // ------------------------------------------------------------- публичное
  readonly health = () => this.http.request({ path: '/health', schema: HealthSchema });

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

  /** Публичный каталог тизеров. */
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

  readonly catalogItem = (id: string) =>
    this.http.request({ path: `/catalog/${id}`, schema: PublicViewSchema });

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
     *
     * Ключ повтора (4.11, M162): форма создаёт его до первой отправки и повторяет тот же,
     * пока ответ не получен, — повтор второго письма не отправит.
     */
    passwordForgot: (email: string, opts: GuardedSend = {}) =>
      this.http.request({
        method: 'POST',
        path: '/auth/password/forgot',
        body: { email },
        schema: AcceptedSchema,
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
      }),

    /** Смена пароля по ссылке из письма. Сессию НЕ открывает. */
    passwordReset: (token: string, password: string) =>
      this.http.request({
        method: 'POST',
        path: '/auth/password/reset',
        body: { token, password },
        schema: z.object({ ok: z.literal(true) }),
      }),

    /** Действует ли ссылка смены пароля. Токен не расходуется. */
    passwordResetCheck: (token: string) =>
      this.http.request({
        method: 'POST',
        path: '/auth/password/reset/check',
        body: { token },
        schema: z.object({ ok: z.literal(true) }),
      }),

    /**
     * Письмо с подтверждением своего адреса. Нужна открытая сессия. `delivery`:
     * `accepted` — принято релеем (не доставка адресату), `unknown` — письмо могло уйти.
     */
    requestEmailVerification: (opts: GuardedSend = {}) =>
      this.http.request({
        method: 'POST',
        path: '/auth/email/verify/request',
        schema: z.object({
          expiresAt: z.string(),
          delivery: z.enum(['accepted', 'unknown']),
        }),
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
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
    investorView: (id: string) =>
      this.http.request({ path: `/projects/${id}/investor-view`, schema: InvestorViewSchema }),

    /** Предпросмотр владельца: что увидит аудитория и кто это увидит. */
    viewPreview: (id: string, params: { audience?: PreviewAudience } = {}) =>
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

    /** Ключ повтора задаёт форма (2.6): повтор после неизвестного результата — с тем же. */
    create: (body: CreateProjectRequest, opts: GuardedSend = {}) =>
      this.http.request({
        method: 'POST',
        path: '/projects',
        body,
        schema: ProjectFullSchema,
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
      }),

    update: (id: string, body: UpdateProjectRequest) =>
      this.http.request({
        method: 'PATCH',
        path: `/projects/${id}`,
        body,
        schema: ProjectFullSchema,
      }),

    /** Публикация листинга. Сервер проверит условия публикации (проверку личности). */
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
        schema: ProjectMediaUploadTicketSchema,
        idempotencyKey: uuidv7(),
      }),

    /**
     * Подтвердить загрузку и задать кадрирование.
     *
     * До этого вызова платформа файл не разбирала: отказ по формату, размеру
     * или размерам изображения приходит именно здесь.
     */
    /**
     * Ключ повтора (2.6, M164) — от идентификатора загрузки: любой повтор подтверждения той
     * же загрузки идёт с тем же ключом и получает прежний результат без повторной обработки.
     */
    finalizeMedia: (id: string, kind: 'logo' | 'cover', body: FinalizeMedia) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/media/${kind}/finalize`,
        body,
        schema: ProjectMediaSchema,
        idempotencyKey: `media-${body.uploadId}`,
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
        schema: MaterialUploadResultSchema,
      }),

    /** Незавершённые и неудачные загрузки текущего пользователя в проекте (1.5). */
    materialUploads: (id: string) =>
      this.http
        .request({ path: `/projects/${id}/material-uploads`, schema: UserOperationsResponseSchema })
        .then((response) => response.items),

    /**
     * Отмена загрузки автором: состояние «отменено», без удаления. Загрузка
     * успела завершиться — в ответе её фактическое состояние.
     */
    cancelUpload: (id: string, materialId: string) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/materials/${materialId}/cancel`,
        schema: MaterialUploadResultSchema,
      }),

    addProductLink: (id: string, body: AddProductLink, opts: GuardedSend = {}) =>
      this.http.request({
        method: 'POST',
        path: `/projects/${id}/materials/link`,
        body,
        schema: ProjectMaterialSchema,
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
      }),

    // askMentor удалён: маршрута `/projects/mentor` на сервере нет. AI Mentor
    // выключен до появления eval-гейта (TODO.md), а метод, компилирующийся, но
    // падающий при вызове, обещает контракт, которого не существует.
  };

  /** Словарь и ЧАВО на языке — публично, с fallback на ru-RU (план 0.2 §2.6). */
  readonly texts = (namespace: TextNamespace, locale = 'ru-RU') =>
    this.http.request({
      path: `/content/texts?namespace=${namespace}&locale=${encodeURIComponent(locale)}`,
      schema: TextsResponseSchema,
    });

  /** Страны обслуживания: список публичен, условия — вошедшему; выбор — за аккаунтом. */
  readonly serviceCountries = {
    list: () =>
      this.http.request({
        path: '/service-countries',
        schema: z.object({ items: z.array(ServiceCountrySchema) }),
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
    },
  };

  /** Публичные флаги интерфейса. */
  readonly features = () => this.http.request({ path: '/features', schema: FeaturesSchema });

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

    open: (body: CreateSupportTicketRequest, opts: GuardedSend = {}) =>
      this.http.request({
        method: 'POST',
        path: '/support/tickets',
        body,
        schema: SupportTicketDetailSchema,
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
      }),

    reply: (id: string, body: string, opts: GuardedSend = {}) =>
      this.http.request({
        method: 'POST',
        path: `/support/tickets/${encodeURIComponent(id)}/messages`,
        body: { body },
        schema: SupportMessageSchema,
        idempotencyKey: opts.idempotencyKey ?? uuidv7(),
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

  /**
   * «Мой профиль» — то, чем человек распоряжается сам.
   *
   * Группа общая для всех кабинетов: профиль один, и расходиться клиентам
   * здесь нельзя. Экран живёт в `@fifth/cabinet` и получает эти методы
   * портом — сам он в сеть не ходит.
   */
  /**
   * Тестовые сессии (M129).
   *
   * Управление — административные маршруты; `currentContext` читается из
   * тестовой вкладки под её контекстом. Разделение намеренное: завершение
   * просмотра остаётся действием администратора, а не участника.
   */
  readonly testing = {
    list: () =>
      this.http.request({ path: '/admin/testing/sessions', schema: TestingSessionListSchema }),
    card: (id: string) =>
      this.http.request({
        path: `/admin/testing/sessions/${id}`,
        schema: TestingSessionCardSchema,
      }),
    create: (body: {
      title: string;
      source?: 'manual' | 'automated';
      scenarioId?: string | null;
      codeVersion?: string | null;
      withStandardCast?: boolean;
    }) =>
      this.http.request({
        path: '/admin/testing/sessions',
        method: 'POST',
        body,
        schema: z.object({ id: z.string().uuid() }),
      }),
    finish: (id: string, result: 'unknown' | 'passed' | 'failed' = 'unknown') =>
      this.http.request({
        path: `/admin/testing/sessions/${id}/finish`,
        method: 'POST',
        body: { result },
        schema: z.object({ ok: z.boolean() }),
      }),
    resume: (id: string) =>
      this.http.request({
        path: `/admin/testing/sessions/${id}/resume`,
        method: 'POST',
        body: {},
        schema: z.object({ ok: z.boolean() }),
      }),
    cleanupPlan: (id: string) =>
      this.http.request({
        path: `/admin/testing/sessions/${id}/cleanup`,
        schema: CleanupPlanSchema,
      }),
    cleanup: (id: string) =>
      this.http.request({
        path: `/admin/testing/sessions/${id}/cleanup`,
        method: 'POST',
        body: {},
        schema: CleanupResultSchema,
      }),
    openParticipant: (sessionId: string, userId: string) =>
      this.http.request({
        path: `/admin/testing/sessions/${sessionId}/contexts`,
        method: 'POST',
        body: { kind: 'participant', userId },
        schema: OpenedContextSchema,
      }),
    openGuest: (sessionId: string) =>
      this.http.request({
        path: `/admin/testing/sessions/${sessionId}/contexts`,
        method: 'POST',
        body: { kind: 'guest' },
        schema: OpenedContextSchema,
      }),
    openUserView: (userId: string) =>
      this.http.request({
        path: '/admin/testing/user-views',
        method: 'POST',
        body: { userId },
        schema: OpenedContextSchema,
      }),
    closeContext: (contextId: string) =>
      this.http.request({
        path: `/admin/testing/contexts/${contextId}`,
        method: 'DELETE',
        schema: z.object({ ok: z.boolean() }),
      }),
    currentContext: () =>
      this.http.request({ path: '/testing/context/current', schema: CurrentContextSchema }),
  };

  /**
   * Длительные операции текущего пользователя (блок 1, 1.5): проверка при
   * загрузке кабинета и возвращении на вкладку, опрос показанной операции и
   * отметка «итог показан».
   */
  readonly operations = {
    pending: () =>
      this.http
        .request({ path: '/me/operations', schema: UserOperationsResponseSchema })
        .then((response) => response.items),

    one: (kind: OperationKind, id: string) =>
      this.http.request({ path: `/me/operations/${kind}/${id}`, schema: UserOperationSchema }),

    notice: (kind: OperationKind, id: string) =>
      this.http.request({
        method: 'POST',
        path: `/me/operations/${kind}/${id}/notice`,
        schema: OperationNoticeResultSchema,
      }),

    /** Исход своей защищённой отправки по ключу (2.6): только чтение, без повтора работы. */
    requestState: (operation: GuardedOperationName, key: string) =>
      this.http.request({
        path: `/me/requests/${operation}/${encodeURIComponent(key)}`,
        schema: RequestKeyStateSchema,
      }),
  };

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
export function createWebClient(baseUrl: string, csrfToken: string | null = null): FifthApi {
  return new FifthApi({ baseUrl, auth: { kind: 'cookie', csrfToken } });
}

/** Клиент для мобильных и сторонних приложений: OAuth PKCE + Bearer. */
export function createBearerClient(baseUrl: string, getToken: () => string | null): FifthApi {
  return new FifthApi({ baseUrl, auth: { kind: 'bearer', getToken } });
}

/** Клиент без аутентификации: только публичные эндпоинты. */
export function createPublicClient(baseUrl: string): FifthApi {
  return new FifthApi({ baseUrl, auth: { kind: 'none' } });
}
