import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from '../common/primitives';

/**
 * Логотип и обложка проекта (этап 7.2; структуры — M119).
 *
 * Владелец загружает ОДНО изображение на каждый вид; размеры для карточки и
 * страницы платформа готовит сама. Кадрирование задаётся точкой фокуса, а не
 * рамкой с ручками: точки достаточно, чтобы не обрезать главное, и она
 * понятна без объяснений.
 *
 * Ссылок на объектное хранилище здесь нет намеренно. Наружу отдаётся только
 * маршрут ядра, который проверяет аудиторию проекта на каждом запросе:
 * изображение закрытого проекта не открывается знанием ссылки.
 */

export const ProjectMediaKindSchema = z.enum(['logo', 'cover']);
export type ProjectMediaKind = z.infer<typeof ProjectMediaKindSchema>;

/** Готовые размеры: `card` — для карточки в списке, `page` — для страницы. */
export const ProjectMediaSizeSchema = z.enum(['card', 'page']);
export type ProjectMediaSize = z.infer<typeof ProjectMediaSizeSchema>;

export const ProjectMediaSchema = z.object({
  kind: ProjectMediaKindSchema,
  /** Что загрузил владелец: тип определён разбором файла, а не заголовком. */
  mime: z.string(),
  bytes: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  focusX: z.number().min(0).max(1),
  focusY: z.number().min(0).max(1),
  /**
   * Адреса готовых размеров — маршруты ядра, не хранилища.
   * Пример: `/v1/projects/<id>/media/cover/card`.
   */
  urls: z.record(ProjectMediaSizeSchema, z.string()),
  updatedAt: IsoDateTimeSchema,
});
export type ProjectMedia = z.infer<typeof ProjectMediaSchema>;

/**
 * Запрос на загрузку: клиент называет размер и тип, платформа выдаёт форму
 * прямой загрузки в хранилище.
 *
 * Названному типу платформа не верит — он нужен только для формы загрузки.
 * Настоящий формат определяется разбором файла после загрузки, и несовпадение
 * означает отказ.
 */
export const RequestMediaUploadSchema = z.object({
  kind: ProjectMediaKindSchema,
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  sizeBytes: z.number().int().positive(),
});
export type RequestMediaUpload = z.infer<typeof RequestMediaUploadSchema>;

export const MediaUploadTicketSchema = z.object({
  uploadUrl: z.string(),
  method: z.literal('POST'),
  formFields: z.record(z.string(), z.string()),
  maxSizeBytes: z.number().int().positive(),
  expiresAt: IsoDateTimeSchema,
});
export type MediaUploadTicket = z.infer<typeof MediaUploadTicketSchema>;

/**
 * Билет загрузки медиа ПРОЕКТА (2.6, M164): своя временная точка у каждой загрузки —
 * подтверждение называет её, и повтор прежнего подтверждения не разберёт следующий файл.
 */
export const ProjectMediaUploadTicketSchema = MediaUploadTicketSchema.extend({
  uploadId: UuidSchema,
});
export type ProjectMediaUploadTicket = z.infer<typeof ProjectMediaUploadTicketSchema>;

/** Подтверждение загрузки: здесь же задаётся точка фокуса. */
export const FinalizeMediaSchema = z.object({
  /** Какую загрузку подтвердить (из билета). */
  uploadId: UuidSchema,
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
});
export type FinalizeMedia = z.infer<typeof FinalizeMediaSchema>;

/** Ограничения показываются пользователю ДО выбора файла, а не после отказа. */
export const MEDIA_LIMITS: Record<
  ProjectMediaKind,
  { maxBytes: number; minWidth: number; minHeight: number }
> = {
  logo: { maxBytes: 2 * 1024 * 1024, minWidth: 128, minHeight: 128 },
  cover: { maxBytes: 5 * 1024 * 1024, minWidth: 640, minHeight: 360 },
};

/** Размеры готовых вариантов. Пропорции разные: логотип квадратный. */
export const MEDIA_VARIANTS: Record<
  ProjectMediaKind,
  Record<ProjectMediaSize, { width: number; height: number }>
> = {
  logo: {
    card: { width: 96, height: 96 },
    page: { width: 192, height: 192 },
  },
  cover: {
    card: { width: 640, height: 360 },
    page: { width: 1600, height: 900 },
  },
};
