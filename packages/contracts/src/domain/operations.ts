import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';
import { MaterialTypeSchema } from './lab';

/**
 * Длительные пользовательские операции (блок 1, 1.5; работа 2.1-W04).
 *
 * Общей очереди нет: операция — прикладная запись своего модуля. В MVP
 * зарегистрирована одна — загрузка материала проекта.
 *
 * Состояния загрузки:
 *  - `pending` — идёт: файл передаётся или сервер его сохраняет;
 *  - `ready` — материал готов;
 *  - `rejected` — файл не подошёл по формату или размеру; нужно действие
 *    пользователя — загрузить другой файл;
 *  - `needs_attention` — сохранить не удалось, автоматическая обработка
 *    остановлена, нужна проверка эксплуатации; повторять загрузку не нужно;
 *  - `cancelled` — отменено автором; поздний файл не публикуется.
 */
export const OPERATION_KINDS = ['material_upload'] as const;
export const OperationKindSchema = z.enum(OPERATION_KINDS);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const UploadStateSchema = z.enum([
  'pending',
  'ready',
  'rejected',
  'needs_attention',
  'cancelled',
]);
export type UploadState = z.infer<typeof UploadStateSchema>;

/** Операция пользователя: видна только инициатору с действующими правами на объект. */
export const UserOperationSchema = z.object({
  kind: OperationKindSchema,
  id: UuidSchema,
  projectId: UuidSchema,
  projectTitle: z.string(),
  materialType: MaterialTypeSchema,
  /** Имя файла из формы; у загрузок до 2.1-W04 его нет. */
  fileName: z.string().nullable(),
  state: UploadStateSchema,
  /** Хранилище подтвердило получение файла: «получен, сохраняем». */
  received: z.boolean(),
  /** Причина — только у `rejected`: она адресована пользователю. */
  reason: z.string().nullable(),
  /**
   * Окончательная ошибка с действием пользователя, ещё не показанная ему ни
   * на одном устройстве: её показывают всплывающим сообщением и отмечают.
   */
  noticePending: z.boolean(),
  startedAt: IsoDateTimeSchema,
  changedAt: IsoDateTimeSchema,
});
export type UserOperation = z.infer<typeof UserOperationSchema>;

/** Проверка при загрузке кабинета и возвращении на вкладку. */
export const UserOperationsResponseSchema = z.object({
  items: z.array(UserOperationSchema),
});
export type UserOperationsResponse = z.infer<typeof UserOperationsResponseSchema>;

export const OperationNoticeResultSchema = z.object({
  noticed: z.literal(true),
});
