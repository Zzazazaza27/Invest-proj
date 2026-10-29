import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';

/**
 * Функциональные полномочия сотрудника (M097): какое действие он вправе делать
 * вообще. Невыданное полномочие запрещено. Денежные полномочия и назначения на
 * сопровождение сделок удалены вместе с инвестиционным процессом (2.1-W05).
 */

export const CapabilityCodeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/, 'код полномочия: разделы через точку');

/**
 * Вид действия: просмотр и денежная корректировка — разные полномочия.
 *
 * `manage` — распоряжение объектом целиком, включая удаление (M129). До него
 * действия с удалением в словаре не было: всё разрушительное пришлось бы
 * выдавать как «изменение», то есть под видом мягкого права.
 */
export const CapabilityActionSchema = z.enum(['view', 'create', 'update', 'confirm', 'manage']);

export const StaffCapabilitySchema = z.object({
  code: CapabilityCodeSchema,
  section: z.string(),
  action: CapabilityActionSchema,
  title: z.string(),
  description: z.string(),
  /** Полномочие реализовано: проверка на него есть в коде. */
  isImplemented: z.boolean(),
  /** Требует области работы — назначения на конкретный объект. */
  requiresAssignment: z.boolean(),
});
export type StaffCapability = z.infer<typeof StaffCapabilitySchema>;

export const StaffCapabilityGrantSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  capability: CapabilityCodeSchema,
  reason: z.string(),
  grantedAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
});
export type StaffCapabilityGrant = z.infer<typeof StaffCapabilityGrantSchema>;

export const GrantCapabilityRequestSchema = z.object({
  userId: UuidSchema,
  capability: CapabilityCodeSchema,
  reason: z.string().trim().min(3).max(500),
});
export type GrantCapabilityRequest = z.infer<typeof GrantCapabilityRequestSchema>;

export const RevokeCapabilityRequestSchema = z.object({
  userId: UuidSchema,
  capability: CapabilityCodeSchema,
  reason: z.string().trim().min(3).max(500),
});
export type RevokeCapabilityRequest = z.infer<typeof RevokeCapabilityRequestSchema>;
