import { z } from 'zod';
import { IsoDateTimeSchema } from '../common/primitives';

/**
 * Доступность групп функций (блок 4, 4.11).
 *
 * Группа связывает пользовательские возможности с их зависимостями. Чтение и изменение
 * учитываются раздельно: недоступная запись не запрещает чтение, если оно работает.
 * Первая подключённая группа — «Файлы» (хранилище). «Почта» и «События» — следующими
 * пакетами.
 */
export const FUNCTION_GROUPS = ['files', 'mail', 'events'] as const;
export const FunctionGroupSchema = z.enum(FUNCTION_GROUPS);
export type FunctionGroup = z.infer<typeof FunctionGroupSchema>;

export const GroupModeSchema = z.enum(['read', 'write']);
export type GroupMode = z.infer<typeof GroupModeSchema>;

/** Сводное состояние группы. «Неизвестно» — не исправность и не доказанный отказ. */
export const GroupStateSchema = z.enum(['available', 'read_only', 'unavailable', 'unknown']);
export type GroupState = z.infer<typeof GroupStateSchema>;

/**
 * Безопасные коды причин: по ним кабинеты выводят тексты. Свободный текст сотрудника и
 * внутренние подробности наружу не отдаются.
 */
export const GROUP_REASONS = [
  'ok',
  'dependency_failure',
  'circuit_open',
  'observations_stale',
  'manual_restriction',
  'not_configured',
] as const;
export const GroupReasonSchema = z.enum(GROUP_REASONS);
export type GroupReason = z.infer<typeof GroupReasonSchema>;

export const ModeStatusSchema = z.object({
  /** Действие этого режима разрешено. */
  allowed: z.boolean(),
  reason: GroupReasonSchema,
  observedAt: IsoDateTimeSchema.nullable(),
});
export type ModeStatus = z.infer<typeof ModeStatusSchema>;

export const GroupStatusSchema = z.object({
  state: GroupStateSchema,
  read: ModeStatusSchema,
  write: ModeStatusSchema,
});
export type GroupStatus = z.infer<typeof GroupStatusSchema>;

export const FunctionGroupsSchema = z.object({ files: GroupStatusSchema, mail: GroupStatusSchema });
export type FunctionGroups = z.infer<typeof FunctionGroupsSchema>;

/** Ручное ограничение эксплуатации: отдельно от продуктовых флагов. */
export const RESTRICTION_REASON_CODES = ['maintenance', 'incident', 'security', 'other'] as const;
export const RestrictionModeSchema = z.enum(['read_only', 'unavailable']);
export type RestrictionMode = z.infer<typeof RestrictionModeSchema>;

export const SetRestrictionRequestSchema = z.object({
  mode: RestrictionModeSchema,
  reasonCode: z.enum(RESTRICTION_REASON_CODES),
  /** Только для журнала и эксплуатации; публично не отдаётся. */
  note: z.string().trim().min(3).max(500),
});
export type SetRestrictionRequest = z.infer<typeof SetRestrictionRequestSchema>;

export const ClearRestrictionRequestSchema = z.object({
  note: z.string().trim().min(3).max(500),
});
export type ClearRestrictionRequest = z.infer<typeof ClearRestrictionRequestSchema>;

/** Взгляд эксплуатации: исправность зависимости и ручной запрет видны раздельно. */
export const DependencyHealthSchema = z.enum(['ok', 'fail', 'unknown']);
export const AdminGroupStatusSchema = z.object({
  group: FunctionGroupSchema,
  status: GroupStatusSchema,
  dependency: z.object({ read: DependencyHealthSchema, write: DependencyHealthSchema }),
  restriction: z
    .object({
      mode: RestrictionModeSchema,
      reasonCode: z.enum(RESTRICTION_REASON_CODES),
      note: z.string(),
      setAt: IsoDateTimeSchema,
    })
    .nullable(),
  instances: z.array(
    z.object({
      instance: z.string(),
      mode: GroupModeSchema,
      ok: z.boolean(),
      reason: GroupReasonSchema,
      observedAt: IsoDateTimeSchema,
      fresh: z.boolean(),
      stopped: z.boolean(),
    }),
  ),
  /**
   * Только у «Событий»: два независимых контура. `publish` — брокер, `delivery` — исходящая
   * сеть (предполагаемый общий сбой в экземпляре) и узлы назначения на паузе.
   */
  contours: z
    .object({
      publish: z.object({ health: DependencyHealthSchema, paused: z.boolean() }),
      delivery: z.object({
        health: DependencyHealthSchema,
        egressSuspected: z.boolean(),
        egressPausedUntil: IsoDateTimeSchema.nullable(),
        pausedDestinations: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  /**
   * Только у «Событий»: очередь — отдельно от доступности. Большая очередь сама по себе не
   * означает отказа транспорта. Возраст — по старейшей незавершённой записи.
   */
  backlog: z
    .object({
      outbox: z.object({
        unpublished: z.number().int().nonnegative(),
        oldestAt: IsoDateTimeSchema.nullable(),
      }),
      deliveries: z.object({
        /** Готовы к отправке сейчас. */
        waiting: z.number().int().nonnegative(),
        /** Ждут срока повтора или паузы своего узла. */
        postponed: z.number().int().nonnegative(),
        exhausted: z.number().int().nonnegative(),
        oldestAt: IsoDateTimeSchema.nullable(),
      }),
      /** Превышен порог числа или возраста (EVENTS_BACKLOG_WARN_*). */
      growing: z.boolean(),
    })
    .optional(),
});
export type AdminGroupStatus = z.infer<typeof AdminGroupStatusSchema>;
