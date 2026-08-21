import { z } from 'zod';
import { boundedString, IsoDateTimeSchema, LocaleSchema, UuidSchema } from '../common/primitives';

/** Роли. `corporate` и `showrunner` зарезервированы под Capital и медиаконтур. */
export const RoleSchema = z.enum([
  'founder',
  'investor',
  'expert',
  'corporate',
  'organizer',
  'admin',
  'showrunner',
]);
export type Role = z.infer<typeof RoleSchema>;

/** Роли, которые пользователь может выбрать сам при регистрации. */
export const SelfServiceRoleSchema = z.enum(['founder', 'investor']);

export const UserStatusSchema = z.enum(['pending_consents', 'active', 'suspended', 'deleted']);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const AuthProviderSchema = z.enum(['email', 'phone', 'telegram', 'google', 'vk', 'apple']);

// ------------------------------------------------------------------- согласия

export const ConsentKindSchema = z.enum([
  'platform_rules',
  'tos',
  'pdn',
  'commission_terms',
  'marketing_communications',
  'pdn_biometric',
]);
export type ConsentKind = z.infer<typeof ConsentKindSchema>;

/**
 * Четыре документа, без акцепта актуальных версий которых аккаунт не
 * активируется. Это сервисный инвариант, а не галочка в UI
 * (Architect_Launch.md §4.1, §5.4). Продублирован в БД триггером.
 */
export const REQUIRED_CONSENT_KINDS = [
  'platform_rules',
  'tos',
  'pdn',
  'commission_terms',
] as const satisfies readonly ConsentKind[];

export const ConsentTemplateSchema = z.object({
  kind: ConsentKindSchema,
  version: boundedString(1, 32),
  locale: LocaleSchema,
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  url: z.url().optional(),
  publishedAt: IsoDateTimeSchema,
});
export type ConsentTemplate = z.infer<typeof ConsentTemplateSchema>;

export const ConsentAcceptanceSchema = z.object({
  kind: ConsentKindSchema,
  version: boundedString(1, 32),
  locale: LocaleSchema,
});

/**
 * Регистрация. Акцепты передаются вместе с заявкой: разделённые экраны — это
 * UX, а условие активации проверяется одной серверной транзакцией.
 */
export const RegisterRequestSchema = z
  .object({
    email: z.email().max(254).optional(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/, 'телефон в формате E.164')
      .optional(),
    password: z
      .string()
      .min(12, 'минимум 12 символов')
      .max(256, 'максимум 256 символов — иначе хеширование становится вектором отказа'),
    displayName: boundedString(2, 120),
    role: SelfServiceRoleSchema,
    locale: LocaleSchema,
    consents: z.array(ConsentAcceptanceSchema).min(REQUIRED_CONSENT_KINDS.length),
  })
  .refine((v) => v.email !== undefined || v.phone !== undefined, {
    message: 'нужен email или телефон',
    path: ['email'],
  })
  .refine((v) => REQUIRED_CONSENT_KINDS.every((kind) => v.consents.some((c) => c.kind === kind)), {
    message:
      'обязательны акцепты: правила платформы, оферта, обработка ПДн, тарифы и вознаграждение оператора',
    path: ['consents'],
  });
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.email().max(254).optional(),
  phone: z.string().max(20).optional(),
  password: z.string().min(1).max(256),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/**
 * Восстановление пароля и подтверждение адреса.
 *
 * Ответ на запрос ссылки — всегда один и тот же (`accepted`), независимо от
 * того, существует ли такой адрес. Разные ответы превратили бы форму «забыли
 * пароль» в инструмент перечисления пользователей: она для этого удобнее формы
 * входа, потому что не требует пароля.
 */
export const PasswordForgotRequestSchema = z.object({
  email: z.email().max(254),
});
export type PasswordForgotRequest = z.infer<typeof PasswordForgotRequestSchema>;

export const PasswordResetRequestSchema = z.object({
  /** 32 случайных байта в base64url. Длина проверяется, чтобы не гонять argon2 на мусоре. */
  token: boundedString(32, 128),
  password: z
    .string()
    .min(12, 'минимум 12 символов')
    .max(256, 'максимум 256 символов — иначе хеширование становится вектором отказа'),
});
export type PasswordResetRequest = z.infer<typeof PasswordResetRequestSchema>;

export const EmailVerifyRequestSchema = z.object({
  token: boundedString(32, 128),
});
export type EmailVerifyRequest = z.infer<typeof EmailVerifyRequestSchema>;

/** Состояние подтверждения адреса — для интерфейса. */
export const EmailVerificationStatusSchema = z.object({
  verified: z.boolean(),
  /** Срок действия уже отправленной ссылки; null — живой ссылки нет. */
  pendingUntil: IsoDateTimeSchema.nullable(),
  /**
   * Подключён ли канал отправки. false — почтового сервера ещё нет, и
   * интерфейс обязан сказать это словами, а не показывать кнопку, которая
   * ответит отказом.
   */
  mailAvailable: z.boolean(),
});
export type EmailVerificationStatus = z.infer<typeof EmailVerificationStatusSchema>;

/** Ответ на запрос письма: одинаковый во всех случаях. */
export const AcceptedSchema = z.object({ status: z.literal('accepted') });

/**
 * Ответ аутентификации. Токен здесь НЕ передаётся: он уходит в httpOnly-cookie.
 * Клиенты с Bearer получают токен напрямую от IdP по OAuth PKCE (ADR-003).
 */
export const AuthSessionSchema = z.object({
  userId: UuidSchema,
  roles: z.array(RoleSchema),
  status: UserStatusSchema,
  /** Токен для double-submit защиты от CSRF: копируется в заголовок X-CSRF-Token. */
  csrfToken: z.string().min(32),
  expiresAt: IsoDateTimeSchema,
  /** true — требуются акцепты новых версий до следующей платёжной операции. */
  reacceptRequired: z.boolean(),
  mfaEnabled: z.boolean(),
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/**
 * Ответ выхода.
 *
 * `tokenRevoked` — не украшение: сервер отзывает предъявленный токен по его
 * идентификатору (M038), но у токена внешнего IdP claim `jti` может
 * отсутствовать. Тогда сессия закрыта только удалением cookie, и клиент обязан
 * знать разницу, а не считать «вышли» в обоих случаях.
 */
export const LogoutResultSchema = z.object({
  ok: z.literal(true),
  tokenRevoked: z.boolean(),
});
export type LogoutResult = z.infer<typeof LogoutResultSchema>;

export const CurrentUserSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  primaryRole: RoleSchema,
  roles: z.array(RoleSchema),
  status: UserStatusSchema,
  locale: LocaleSchema,
  mfaEnabled: z.boolean(),
  /** Маскированные контакты: полные значения наружу не отдаются. */
  emailMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;

export const InvestorProfileSchema = z.object({
  about: boundedString(0, 4000).nullable(),
  focusTaxonomyIds: z.array(UuidSchema).max(20),
  checkSizeMin: z.string().nullable(),
  checkSizeMax: z.string().nullable(),
  kycStatus: z.enum(['none', 'pending', 'approved', 'rejected']),
  entityId: UuidSchema.nullable(),
});
export type InvestorProfile = z.infer<typeof InvestorProfileSchema>;

/** Согласие на публичный контур (шов к медиаконтуру Шоу). */
export const PublicationScopeSchema = z.enum([
  'episode_selection',
  'episode_bootcamp',
  'final_live',
  'top100_public',
]);

/**
 * Что именно раскрывается в публичный контур.
 *
 * Перечисление, а не свободная строка. Прежний контракт принимал любые 50 строк
 * по 64 символа — а этот список читает медиаконтур и решает по нему, что можно
 * показать. Свободный текст означал бы, что согласие описывает раскрытие
 * словами, которые никто не сверяет: `founder_photo` и `фото основателя` — для
 * потребителя разные значения, а `passport_scan` он не поймёт вовсе и может
 * счесть разрешением. Закрытый словарь — единственная форма, в которой такой
 * список можно исполнить, а не пересказать.
 */
export const PublicationDisclosableFieldSchema = z.enum([
  'project_title',
  'project_tagline',
  'project_description',
  'project_stage',
  'project_geo',
  'investment_ask',
  'founder_display_name',
  'founder_photo',
  'founder_video',
  'team_members',
  'metrics',
  'pitch_deck',
]);
export type PublicationDisclosableField = z.infer<typeof PublicationDisclosableFieldSchema>;

export const PublicationConsentRequestSchema = z.object({
  projectId: UuidSchema,
  scope: PublicationScopeSchema,
  /** Пустой список — законное согласие «снимать можно, данные проекта не раскрывать». */
  disclosedFields: z.array(PublicationDisclosableFieldSchema).max(12),
  /**
   * Версия документа, который человек принял.
   *
   * Сверяется с действующим шаблоном `pdn_biometric` на сервере: отпечаток
   * текста берётся оттуда же и в тело запроса не принимается. Клиент, который
   * прислал бы и версию, и хеш, доказывал бы этим только сам себя.
   */
  documentVersion: boundedString(1, 32),
});
export type PublicationConsentRequest = z.infer<typeof PublicationConsentRequestSchema>;

/** Выданное согласие в том виде, в каком его возвращает API. */
export const PublicationConsentSchema = z.object({
  id: UuidSchema,
  projectId: UuidSchema,
  scope: PublicationScopeSchema,
  disclosedFields: z.array(PublicationDisclosableFieldSchema),
  documentVersion: z.string(),
  /** hex sha256 текста документа — доказательство, ЧТО именно было принято. */
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  acceptedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
  /**
   * Крайний срок удаления публичной проекции. Не null только у отозванного
   * согласия: пока согласие действует, удалять нечего.
   */
  deletionDeadline: IsoDateTimeSchema.nullable(),
});
export type PublicationConsent = z.infer<typeof PublicationConsentSchema>;
