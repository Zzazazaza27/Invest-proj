import { z } from 'zod';
import { boundedString, IsoDateTimeSchema, LocaleSchema, UuidSchema } from '../common/primitives';
import { ServiceCountryCodeSchema } from './service-country';

/**
 * Роли. `corporate` зарезервирована под Capital. Роли эксперта, организатора
 * сезона и шоураннера удалены вместе с их функциями (2.1-W05).
 */
export const RoleSchema = z.enum(['founder', 'investor', 'corporate', 'admin']);
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
 * (docs/architecture/Architect_Launch.md §4.1, §5.4). Продублирован в БД триггером.
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
    /**
     * Страна обслуживания аккаунта (этап 5.6.5): первичный выбор при
     * регистрации из активных стран; необязательна — без неё страну попросят
     * выбрать перед открытием раунда. Смены страны нет (реестр решений).
     */
    serviceCountry: ServiceCountryCodeSchema.optional(),
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

/** Проверка ссылки смены пароля при открытии страницы: токен не расходуется. */
export const PasswordResetCheckSchema = z.object({
  token: boundedString(32, 128),
});
export type PasswordResetCheck = z.infer<typeof PasswordResetCheckSchema>;

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
  /** Страна обслуживания аккаунта (план 0.2 §0г.2 п.7); null — не выбрана. */
  serviceCountry: z.string().nullable().optional(),
  /** Маскированные контакты: полные значения наружу не отдаются. */
  emailMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  /**
   * Маленький аватар для шапки — маршрут ядра, а не ключ хранилища. `null`,
   * если человек его не загружал: кабинет рисует первую букву имени.
   *
   * Поле живёт в «кто я», а не запрашивается отдельно: шапка рисуется на
   * каждой странице, и второй запрос ради одной картинки — это второй запрос
   * на каждой странице.
   */
  avatarUrl: z.string().nullable().optional(),
  createdAt: IsoDateTimeSchema,
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
