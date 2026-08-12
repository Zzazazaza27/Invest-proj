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

export const PublicationConsentRequestSchema = z.object({
  projectId: UuidSchema,
  scope: PublicationScopeSchema,
  disclosedFields: z.array(boundedString(1, 64)).max(50),
  documentVersion: boundedString(1, 32),
});
export type PublicationConsentRequest = z.infer<typeof PublicationConsentRequestSchema>;
