import { z } from 'zod';
import {
  boundedString,
  CountryCodeSchema,
  IsoDateTimeSchema,
  UuidSchema,
} from '../common/primitives';

// ------------------------------------------------------------------- KYC/KYB

export const KycStatusSchema = z.enum([
  'pending',
  'in_review',
  'approved',
  'rejected',
  'verification_pending',
]);
export type KycStatus = z.infer<typeof KycStatusSchema>;

export const StartKycRequestSchema = z.object({
  kind: z.enum(['identity', 'investor_status', 'accredited']),
  docType: z.enum(['passport', 'foreign_passport', 'id_card', 'driver_license']),
  docCountry: CountryCodeSchema,
});
export type StartKycRequest = z.infer<typeof StartKycRequestSchema>;

/**
 * Статус верификации. Наружу не отдаются ни документы, ни причина отказа в
 * терминах комплаенса: только статус и общая формулировка.
 */
export const KycVerificationSchema = z.object({
  id: UuidSchema,
  kind: z.string(),
  status: KycStatusSchema,
  /** Обобщённая причина. Детали остаются во внутреннем контуре комплаенса. */
  rejectionSummary: z.string().nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  /**
   * Имя заявителя — только в очереди комплаенса, где решение принимает человек.
   *
   * Оператор видел одну строку идентификатора и вид проверки: одобрять
   * неизвестно кого — это не решение, а нажатие кнопки. Адрес почты сюда НЕ
   * выносится: он лежит в базе зашифрованным, и вытаскивать его в список
   * означало бы потерять и шифрование на покое, и журнал доступа.
   */
  subjectName: z.string().nullable().optional(),
});
export type KycVerification = z.infer<typeof KycVerificationSchema>;

export const CreateEntityRequestSchema = z.object({
  legalName: boundedString(2, 300),
  legalForm: boundedString(0, 100).optional(),
  inn: z.string().regex(/^\d{10}$|^\d{12}$/, 'ИНН: 10 цифр для юрлица, 12 для ИП'),
  ogrn: z.string().regex(/^\d{13}$|^\d{15}$/, 'ОГРН: 13 или 15 цифр'),
  jurisdiction: CountryCodeSchema,
});
export type CreateEntityRequest = z.infer<typeof CreateEntityRequestSchema>;

export const BusinessEntitySchema = z.object({
  id: UuidSchema,
  legalName: z.string(),
  legalForm: z.string().nullable(),
  /** ИНН маскируется: полное значение шифруется и наружу не выдаётся. */
  innMasked: z.string(),
  jurisdiction: CountryCodeSchema,
  registryStatus: z.enum(['active', 'liquidating', 'liquidated', 'unknown']),
  kybApproved: z.boolean(),
  createdAt: IsoDateTimeSchema,
});
export type BusinessEntity = z.infer<typeof BusinessEntitySchema>;

/**
 * Решение комплаенса по верификации. Принимается ТОЛЬКО ролью admin и только
 * над чужой заявкой: самоодобрение закрыто и политикой RLS, и сервисным слоем.
 */
export const KycDecisionRequestSchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    /** Причина обязательна при отказе — это требование аудита, не UX. */
    reason: boundedString(3, 500).optional(),
    riskLevel: z.enum(['low', 'medium', 'high', 'prohibited']).optional(),
    /** Срок действия проверки: без него ежегодный пересмотр невозможен. */
    expiresAt: IsoDateTimeSchema.optional(),
  })
  .refine((v) => v.decision !== 'rejected' || Boolean(v.reason), {
    message: 'при отказе причина обязательна',
    path: ['reason'],
  });
export type KycDecisionRequest = z.infer<typeof KycDecisionRequestSchema>;

export const StartKybRequestSchema = z.object({
  kind: z.enum(['registry_check', 'beneficial_owners', 'accreditation', 'annual_review']),
});
export type StartKybRequest = z.infer<typeof StartKybRequestSchema>;

export const KybVerificationSchema = z.object({
  id: UuidSchema,
  entityId: UuidSchema,
  kind: z.string(),
  status: KycStatusSchema,
  rejectionSummary: z.string().nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type KybVerification = z.infer<typeof KybVerificationSchema>;

export const EntityMemberRoleSchema = z.enum(['signatory', 'beneficial_owner', 'representative']);

export const AddEntityMemberRequestSchema = z
  .object({
    userId: UuidSchema,
    memberRole: EntityMemberRoleSchema,
    sharePct: z
      .string()
      .regex(/^\d{1,3}(\.\d{1,2})?$/, 'доля: до 100 с двумя знаками')
      .optional(),
  })
  .refine((v) => v.memberRole !== 'beneficial_owner' || Boolean(v.sharePct), {
    message: 'для бенефициара доля обязательна',
    path: ['sharePct'],
  });
export type AddEntityMemberRequest = z.infer<typeof AddEntityMemberRequestSchema>;

export const EntityMemberSchema = z.object({
  entityId: UuidSchema,
  userId: UuidSchema,
  memberRole: EntityMemberRoleSchema,
  sharePct: z.string().nullable(),
  verifiedAt: IsoDateTimeSchema.nullable(),
});
export type EntityMember = z.infer<typeof EntityMemberSchema>;

// -------------------------------------------------------------- уведомления

export const NotificationChannelSchema = z.enum(['push', 'telegram', 'email', 'sms', 'inapp']);
export type NotificationChannel = z.infer<typeof NotificationChannelSchema>;

export const NotificationTopicSchema = z.enum([
  'all',
  'projects',
  'messages',
  'security',
  'marketing',
]);
export type NotificationTopic = z.infer<typeof NotificationTopicSchema>;

/** Темы, которые нельзя отключить. Дублируется CHECK-ограничением в БД. */
export const UNDISABLEABLE_TOPICS = ['security'] as const;

export const NotificationPreferenceSchema = z
  .object({
    channel: NotificationChannelSchema,
    topic: NotificationTopicSchema,
    enabled: z.boolean(),
    quietHoursTz: z.string().max(64).nullable().optional(),
    quietFrom: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
    quietTo: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .nullable()
      .optional(),
  })
  .refine((v) => !(UNDISABLEABLE_TOPICS as readonly string[]).includes(v.topic) || v.enabled, {
    message: 'уведомления о безопасности и платежах отключить нельзя',
    path: ['enabled'],
  });
export type NotificationPreference = z.infer<typeof NotificationPreferenceSchema>;

export const RegisterDeviceRequestSchema = z.object({
  platform: z.enum(['ios', 'android', 'web_pwa']),
  pushProvider: z.enum(['fcm', 'apns', 'web_push']),
  pushToken: boundedString(10, 4096),
  deviceName: boundedString(0, 120).optional(),
  appVersion: boundedString(0, 40).optional(),
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

/**
 * Устройство в ответе. Push-токена здесь НЕТ намеренно: он позволяет слать
 * уведомления от имени приложения, поэтому наружу не возвращается даже
 * владельцу — отдать его обратно клиенту незачем, а утечь он может.
 */
export const UserDeviceSchema = z.object({
  id: UuidSchema,
  platform: z.enum(['ios', 'android', 'web_pwa']),
  pushProvider: z.enum(['fcm', 'apns', 'web_push']),
  deviceName: z.string().nullable(),
  appVersion: z.string().nullable(),
  lastSeenAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
});
export type UserDevice = z.infer<typeof UserDeviceSchema>;

/**
 * Шаблон текста уведомления.
 *
 * Версия — часть идентичности шаблона, а не служебное поле: активной остаётся
 * одна версия на (code, channel, locale), прежние сохраняются как история того,
 * что платформа действительно писала пользователям.
 */
export const NotificationTemplateSchema = z.object({
  id: UuidSchema,
  code: z.string(),
  channel: NotificationChannelSchema,
  locale: z.string(),
  version: z.number().int().positive(),
  titleTemplate: z.string().nullable(),
  bodyTemplate: z.string(),
  fallbackChain: z.array(z.string()),
  isCritical: z.boolean(),
  isActive: z.boolean(),
});
export type NotificationTemplate = z.infer<typeof NotificationTemplateSchema>;

/**
 * Сохранение текста. Номер версии клиент НЕ называет: его выдаёт сервер, иначе
 * два администратора, редактирующих один шаблон, назначили бы одинаковую версию.
 */
export const UpsertNotificationTemplateSchema = z.object({
  code: boundedString(3, 100).regex(
    /^[a-z][a-z0-9_.]*$/,
    'код шаблона — латиница, точки, подчёркивания',
  ),
  channel: NotificationChannelSchema,
  locale: z.enum(['ru-RU', 'en-US']).default('ru-RU'),
  titleTemplate: boundedString(0, 200).nullable().optional(),
  bodyTemplate: boundedString(1, 4000),
  fallbackChain: z.array(NotificationChannelSchema).max(4).default([]),
  isCritical: z.boolean().default(false),
});
export type UpsertNotificationTemplate = z.infer<typeof UpsertNotificationTemplateSchema>;

/** Пакетное обновление предпочтений: настройки меняют экраном, а не по одной. */
export const UpdatePreferencesRequestSchema = z.object({
  items: z.array(NotificationPreferenceSchema).min(1).max(100),
});
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;

export const NotificationSchema = z.object({
  id: UuidSchema,
  channel: NotificationChannelSchema,
  templateCode: z.string(),
  payload: z.record(z.string(), z.unknown()),
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'skipped_by_preference']),
  createdAt: IsoDateTimeSchema,
  sentAt: IsoDateTimeSchema.nullable(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// -------------------------------------------------------------- служебное

export const HealthSchema = z.object({
  /** Сигнатура сервиса: по ней внешние проверки отличают наш API от чужого. */
  service: z.literal('fifth-core'),
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type Health = z.infer<typeof HealthSchema>;

export const FeatureFlagsSchema = z.record(z.string(), z.boolean());
export type FeatureFlags = z.infer<typeof FeatureFlagsSchema>;

/**
 * Строка поиска пользователей для админки.
 *
 * Адрес почты сюда не выносится: он лежит зашифрованным, и показывать его
 * списком значило бы потерять и шифрование на покое, и журнал доступа. Для
 * различения тёзок хватает роли и первых знаков идентификатора — по ним же
 * сверяют записи в журнале.
 */
export const AdminUserSummarySchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  roles: z.array(z.string()),
  status: z.string(),
  createdAt: IsoDateTimeSchema,
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

/** Строка поиска проектов для админки. */
export const AdminProjectSummarySchema = z.object({
  id: UuidSchema,
  title: z.string(),
  status: z.string(),
  listingStatus: z.string(),
});
export type AdminProjectSummary = z.infer<typeof AdminProjectSummarySchema>;
