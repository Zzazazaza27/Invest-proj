import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';
import { GrantPermissionSchema, ProjectVisibilitySchema } from './visibility';

/**
 * Выдача и отзыв разрешений выбранным получателям (этап 5.8, план
 * `заявка-04` §3.2–3.3; таблицы `lab.project_access_grants` и
 * `lab.project_access_exclusions`, M087; справочные функции M091).
 *
 * Разрешение — НАБОР независимых частей (`profile`, `round`, `materials`,
 * `passport`, `extended`), не уровень. Тизер в наборе не выдаётся: он есть у
 * всякого, у кого есть хоть одно действующее разрешение, — поэтому
 * `GrantPermissionSchema` его и не содержит.
 *
 * Исключение перекрывает и режим проекта, и любое разрешение.
 */

export const AccessSubjectKindSchema = z.enum(['user', 'entity']);
export type AccessSubjectKind = z.infer<typeof AccessSubjectKindSchema>;

export const ProjectAccessEntrySchema = z.object({
  id: UuidSchema,
  /** `grant` — выданные разрешения; `exclusion` — запрет поверх всего. */
  kind: z.enum(['grant', 'exclusion']),
  subjectKind: AccessSubjectKindSchema,
  subjectId: UuidSchema,
  /** Имя получателя; адрес электронной почты наружу не возвращается. */
  subjectName: z.string(),
  /** Для исключения — пустой список: исключение не про набор разрешений. */
  permissions: z.array(GrantPermissionSchema),
  createdAt: IsoDateTimeSchema,
  reason: z.string().nullable(),
  /** Отозвано: запись остаётся историей, доступ закрыт. */
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type ProjectAccessEntry = z.infer<typeof ProjectAccessEntrySchema>;

export const ProjectAccessListSchema = z.object({
  /** Режим проекта рядом: без `selected_investors` выданное не действует. */
  visibility: ProjectVisibilitySchema,
  grants: z.array(ProjectAccessEntrySchema),
  exclusions: z.array(ProjectAccessEntrySchema),
});
export type ProjectAccessList = z.infer<typeof ProjectAccessListSchema>;

/**
 * Получатель называется точным адресом электронной почты: поиска по людям у
 * владельца проекта нет и не появляется — это был бы справочник платформы.
 */
export const GrantAccessRequestSchema = z.object({
  email: z.email().max(254),
  permissions: z.array(GrantPermissionSchema).min(1).max(5),
  reason: z.string().trim().max(500).optional(),
});
export type GrantAccessRequest = z.infer<typeof GrantAccessRequestSchema>;

export const ExcludeAccessRequestSchema = z.object({
  email: z.email().max(254),
  reason: z.string().trim().max(500).optional(),
});
export type ExcludeAccessRequest = z.infer<typeof ExcludeAccessRequestSchema>;
