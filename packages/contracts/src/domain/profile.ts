import { z } from 'zod';
import { IsoDateTimeSchema, boundedString } from '../common/primitives';
import { UserStatusSchema } from './identity';

/**
 * «Мой профиль» — то, чем человек распоряжается сам (этап 6.4).
 *
 * Граница проходит не по удобству, а по тому, кто отвечает за правду поля:
 *
 *  * **обычное профильное поле** — человек сообщил его о себе сам
 *    (отображаемое имя, аватар). Меняется здесь и сразу;
 *  * **подтверждённые данные** — контакт, прошедший проверку, и данные
 *    личности из KYC. Здесь только показываются, и рядом сказано, каким
 *    процессом они меняются. Перезаписывать их «обычной формой профиля»
 *    значило бы обесценить саму проверку;
 *  * **пароль** — меняется здесь, но по своим правилам: со знанием текущего
 *    и с прекращением всех сессий.
 */

export const MyAvatarSchema = z.object({
  /** Маршруты ядра, не хранилища: `/v1/users/<id>/avatar/<size>`. */
  urls: z.record(z.enum(['sm', 'md']), z.string()),
  updatedAt: IsoDateTimeSchema,
});
export type MyAvatar = z.infer<typeof MyAvatarSchema>;

export const MyProfileSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  avatar: MyAvatarSchema.nullable(),
  /** Контакт показывается маской: полное значение человек и так знает. */
  emailMasked: z.string().nullable(),
  phoneMasked: z.string().nullable(),
  roles: z.array(z.string()),
  primaryRole: z.string(),
  status: UserStatusSchema,
  locale: z.string(),
  serviceCountry: z.string().nullable(),
  createdAt: IsoDateTimeSchema,
  /**
   * Доступна ли смена пароля. В контуре с внешним поставщиком входа пароля у
   * платформы нет вовсе, и форма не показывается — вместо неё объяснение.
   */
  passwordChangeAvailable: z.boolean(),
});
export type MyProfile = z.infer<typeof MyProfileSchema>;

export const UpdateMyProfileSchema = z.object({
  displayName: boundedString(2, 120),
});
export type UpdateMyProfile = z.infer<typeof UpdateMyProfileSchema>;

/**
 * Смена пароля.
 *
 * Текущий пароль обязателен: без него захваченная вкладка меняет пароль и
 * запирает владельца снаружи. Правила нового — те же, что при регистрации;
 * разойтись они не должны.
 */
export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z
    .string()
    .min(12, 'минимум 12 символов')
    .max(256, 'максимум 256 символов — иначе хеширование становится вектором отказа'),
});
export type ChangePassword = z.infer<typeof ChangePasswordSchema>;

/**
 * Ответ на смену пароля.
 *
 * `sessionsClosed` — не украшение: смена пароля прекращает ВСЕ сессии,
 * включая текущую, и человек обязан узнать об этом до того, как увидит экран
 * входа.
 */
export const ChangePasswordResultSchema = z.object({
  changed: z.literal(true),
  sessionsClosed: z.literal(true),
});
export type ChangePasswordResult = z.infer<typeof ChangePasswordResultSchema>;

// -------------------------------------------------------------------- аватар

export const RequestAvatarUploadSchema = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive(),
});
export type RequestAvatarUpload = z.infer<typeof RequestAvatarUploadSchema>;

/** Ограничения показываются человеку ДО выбора файла, а не после отказа. */
export const AVATAR_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  minWidth: 96,
  minHeight: 96,
} as const;

/** Два размера: в строке списка и в шапке. Больше пока незачем. */
export const AVATAR_VARIANTS = {
  sm: { width: 64, height: 64 },
  md: { width: 192, height: 192 },
} as const;

export const AvatarSizeSchema = z.enum(['sm', 'md']);
export type AvatarSize = z.infer<typeof AvatarSizeSchema>;
