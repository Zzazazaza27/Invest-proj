import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import {
  MEDIA_LIMITS,
  MEDIA_VARIANTS,
  uuidv7,
  type FinalizeMedia,
  type MediaUploadTicket,
  type ProjectMedia,
  type ProjectMediaKind,
  type ProjectMediaSize,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { S3Service, putObject } from '../storage/s3.service';

/**
 * Логотип и обложка проекта (7.2).
 *
 * Здесь три обязанности, и каждая отвечает на конкретную угрозу.
 *
 * **1. Не верить клиенту.** Формат определяется разбором файла, а не
 * заголовком `Content-Type` и не расширением. «PNG», внутри которого лежит
 * что угодно, до хранилища вариантов не доходит.
 *
 * **2. Ограничить обработку.** Пользовательское изображение — это вход,
 * который выбрал не мы: гигантский холст, «зип-бомба» из пикселей, анимация
 * на тысячу кадров. Поэтому у разбора есть предел по пикселям, по байтам и по
 * числу одновременных обработок, а результат всегда пересобирается заново —
 * лишние метаданные (в том числе координаты съёмки) не переживают пересборку.
 *
 * **3. Не открывать чужое.** Байты отдаёт маршрут ядра после проверки
 * аудитории проекта. Бакет остаётся приватным, публичной раздачи объектов
 * нет, и знание ссылки доступа не даёт.
 */
@Injectable()
export class ProjectMediaService {
  private readonly logger = new Logger(ProjectMediaService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly s3: S3Service,
  ) {
    // Обработка идёт в пуле libvips. Без ограничения один большой файл
    // занимает все ядра и кладёт отзывчивость всего ядра приложения.
    sharp.concurrency(MAX_CONCURRENCY);
    sharp.cache(false);
  }

  /**
   * Форма прямой загрузки в хранилище.
   *
   * Байты не идут через ядро: тело запроса ограничено мегабайтом, и поднимать
   * этот предел ради картинок значило бы открыть его для всего остального.
   * Оригинал попадает во ВРЕМЕННЫЙ ключ и станет медиа только после разбора.
   */
  async requestUpload(
    ctx: RequestContext,
    projectId: string,
    input: { kind: ProjectMediaKind; contentType: string; sizeBytes: number },
  ): Promise<MediaUploadTicket> {
    if (!this.s3.isConfigured) throw errors.featureDisabled('media_upload');

    const limits = MEDIA_LIMITS[input.kind];
    if (input.sizeBytes > limits.maxBytes) {
      throw errors.validation([
        {
          path: 'sizeBytes',
          message: `${input.kind === 'logo' ? 'Логотип' : 'Обложка'}: не больше ${Math.round(
            limits.maxBytes / (1024 * 1024),
          )} МБ`,
        },
      ]);
    }

    await this.db.readOnly(ctx, async (tx) => this.assertCanEdit(tx, projectId));

    const form = this.s3.presignUpload({
      key: uploadKey(projectId, input.kind),
      contentType: input.contentType,
      maxBytes: limits.maxBytes,
    });
    return {
      uploadUrl: form.url,
      method: 'POST',
      formFields: form.fields,
      maxSizeBytes: limits.maxBytes,
      expiresAt: form.expiresAt.toISOString(),
    };
  }

  /**
   * Разобрать загруженное и подготовить размеры.
   *
   * Порядок обратный удобству и прямой по смыслу: сперва проверить, что это
   * вообще изображение подходящего формата и размера, и только потом что-то
   * записывать. Негодный файл удаляется из хранилища — мусор, оставленный
   * «на всякий случай», однажды кто-нибудь раздаст.
   */
  async finalize(
    ctx: RequestContext,
    projectId: string,
    kind: ProjectMediaKind,
    input: FinalizeMedia,
  ): Promise<ProjectMedia> {
    if (!this.s3.isConfigured) throw errors.featureDisabled('media_upload');
    await this.db.readOnly(ctx, async (tx) => this.assertCanEdit(tx, projectId));

    const key = uploadKey(projectId, kind);
    const object = await this.s3.getObject(key);
    if (!object) {
      throw errors.stateTransition('Файл не загружен: сначала отправьте изображение');
    }

    const limits = MEDIA_LIMITS[kind];
    if (object.body.byteLength > limits.maxBytes) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([{ path: 'file', message: 'Файл больше допустимого размера' }]);
    }

    let meta: sharp.Metadata;
    let normalized: { data: Buffer; info: sharp.OutputInfo };
    try {
      meta = await sharp(object.body, SHARP_INPUT).metadata();
      // Поворот по EXIF применяется СРАЗУ и один раз: дальше и проверка
      // размеров, и кадрирование идут по тому изображению, которое человек
      // видит, а не по тому, как оно лежит в файле. Портретное фото иначе
      // проверялось бы и обрезалось по неверной стороне.
      normalized = await sharp(object.body, SHARP_INPUT)
        .rotate()
        .toBuffer({ resolveWithObject: true });
    } catch {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([{ path: 'file', message: 'Это не изображение или файл повреждён' }]);
    }

    const mime = MIME_BY_FORMAT[meta.format ?? ''];
    if (!mime) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([{ path: 'file', message: 'Подходят только JPEG, PNG и WebP' }]);
    }
    const width = normalized.info.width;
    const height = normalized.info.height;
    if (width < limits.minWidth || height < limits.minHeight) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([
        {
          path: 'file',
          message: `Слишком маленькое изображение: нужно не меньше ${limits.minWidth}×${limits.minHeight} точек`,
        },
      ]);
    }
    if (width > MAX_SIDE || height > MAX_SIDE) {
      await this.s3.deleteObject(key).catch(() => undefined);
      throw errors.validation([
        { path: 'file', message: `Слишком большое изображение: сторона до ${MAX_SIDE} точек` },
      ]);
    }

    // Варианты собираются из ОРИГИНАЛА заново. Побочный результат пересборки
    // важнее самого сжатия: всё, что было в файле помимо пикселей — EXIF с
    // координатами съёмки, цветовые профили, комментарии, — не переносится.
    const mediaId = uuidv7();
    const variants: Record<string, { key: string; width: number; height: number }> = {};
    for (const [size, box] of Object.entries(MEDIA_VARIANTS[kind]) as [
      ProjectMediaSize,
      { width: number; height: number },
    ][]) {
      // Обрезка считается от ТОЧКИ ФОКУСА владельца, а не «по центру» и не
      // алгоритмом «где интереснее»: человек указал, что должно остаться в
      // кадре, и это указание нельзя переигрывать эвристикой.
      const crop = cropAround(width, height, box, input.focusX, input.focusY);
      const buffer = await sharp(normalized.data, SHARP_INPUT)
        .extract(crop)
        .resize({ width: box.width, height: box.height, fit: 'fill' })
        .webp({ quality: 82 })
        .toBuffer();
      const variantKey = variantObjectKey(projectId, kind, mediaId, size);
      await putObject({
        key: variantKey,
        body: buffer,
        contentType: 'image/webp',
      });
      variants[size] = { key: variantKey, width: box.width, height: box.height };
    }

    const masterKey = masterObjectKey(projectId, kind, mediaId);
    await putObject({ key: masterKey, body: object.body, contentType: mime });
    await this.s3.deleteObject(key).catch(() => undefined);

    const media = await this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `INSERT INTO lab.project_media
           (id, project_id, kind, master_key, variants, mime, bytes, width, height,
            focus_x, focus_y, uploaded_by, updated_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, now())
         ON CONFLICT (project_id, kind) DO UPDATE
           SET master_key = EXCLUDED.master_key,
               variants = EXCLUDED.variants,
               mime = EXCLUDED.mime,
               bytes = EXCLUDED.bytes,
               width = EXCLUDED.width,
               height = EXCLUDED.height,
               focus_x = EXCLUDED.focus_x,
               focus_y = EXCLUDED.focus_y,
               uploaded_by = EXCLUDED.uploaded_by,
               updated_at = now()`,
        [
          mediaId,
          projectId,
          kind,
          masterKey,
          JSON.stringify(variants),
          mime,
          object.body.byteLength,
          width,
          height,
          input.focusX,
          input.focusY,
          ctx.userId,
        ],
      );
      await this.audit.emit(tx, {
        verb: 'lab.project_media.set',
        actorId: ctx.userId,
        actorRole: ctx.roles?.includes('admin') ? 'admin' : 'founder',
        subjectType: 'project',
        subjectId: projectId,
        context: { kind, mime, width, height, bytes: object.body.byteLength },
        traceId: ctx.traceId,
      });
      return (await this.readRow(tx, projectId, kind))!;
    });

    // Прежние объекты НЕ удаляются физически (блок 7, 2.1-W07): файл, уже
    // попавший в комплект резервной копии, должен остаться и в хранилище.
    // Очистка неиспользуемых объектов — отдельной процедурой по 3.3.

    return view(projectId, media);
  }

  /** Убрать изображение: запись удаляется, объекты остаются (блок 7). */
  async remove(ctx: RequestContext, projectId: string, kind: ProjectMediaKind): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      await this.assertCanEdit(tx, projectId);
      const existing = await this.readRow(tx, projectId, kind);
      if (!existing) return null;
      await tx.query(`DELETE FROM lab.project_media WHERE project_id = $1 AND kind = $2`, [
        projectId,
        kind,
      ]);
      await this.audit.emit(tx, {
        verb: 'lab.project_media.removed',
        actorId: ctx.userId,
        actorRole: ctx.roles?.includes('admin') ? 'admin' : 'founder',
        subjectType: 'project',
        subjectId: projectId,
        context: { kind },
        traceId: ctx.traceId,
      });
      return existing;
    });
  }

  /** Что показывать в карточке и на странице. Пусто — изображения нет. */
  async forProject(ctx: RequestContext, projectId: string): Promise<ProjectMedia[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<MediaRow>(
        `${SELECT_MEDIA} WHERE project_id = $1 ORDER BY kind`,
        [projectId],
      );
      return rows.map((row) => view(projectId, row));
    });
  }

  /**
   * Байты варианта.
   *
   * Единственная дверь к изображению. Аудитория проверяется здесь и на каждом
   * запросе — политика чтения `lab.project_media` не пускает к строке того,
   * кому не виден проект, поэтому «нет доступа» и «нет изображения»
   * оказываются одним и тем же ответом. Это не небрежность: посторонний не
   * должен по коду ответа узнавать, что проект существует.
   */
  async variant(
    ctx: RequestContext,
    projectId: string,
    kind: ProjectMediaKind,
    size: ProjectMediaSize,
  ): Promise<{ body: Buffer; contentType: string }> {
    const row = await this.db.readOnly(ctx, async (tx) => this.readRow(tx, projectId, kind));
    const variant = row?.variants?.[size];
    if (!variant) throw errors.notFound({ subject: 'project_media' });

    const object = await this.s3.getObject(variant.key);
    if (!object) {
      this.logger.error({ msg: 'вариант изображения потерян', projectId, kind, size });
      throw errors.notFound({ subject: 'project_media' });
    }
    return { body: object.body, contentType: 'image/webp' };
  }

  // ------------------------------------------------------------------ helpers

  private async assertCanEdit(tx: Tx, projectId: string): Promise<void> {
    const { rows } = await tx.query<{ can_edit: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM lab.founders_projects fp
          WHERE fp.project_id = $1 AND fp.user_id = app.current_user_id()
            AND fp.role IN ('owner','cofounder')) AS can_edit
         FROM lab.projects p WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId],
    );
    if (!rows[0]) throw errors.notFound({ subject: 'project' });
    if (!rows[0].can_edit) throw errors.forbidden({ stage: 'not-project-editor' });
  }

  private async readRow(
    tx: Tx,
    projectId: string,
    kind: ProjectMediaKind,
  ): Promise<MediaRow | null> {
    const { rows } = await tx.query<MediaRow>(
      `${SELECT_MEDIA} WHERE project_id = $1 AND kind = $2`,
      [projectId, kind],
    );
    return rows[0] ?? null;
  }
}

const SELECT_MEDIA = `
  SELECT kind, master_key, variants, mime, bytes, width, height,
         focus_x::float8 AS focus_x, focus_y::float8 AS focus_y, updated_at
    FROM lab.project_media`;

/** Пределы разбора: вход выбирали не мы. */
const MAX_SIDE = 6000;
const MAX_CONCURRENCY = 2;
const SHARP_INPUT: sharp.SharpOptions = {
  // 60 мегапикселей: заведомо больше любого реального логотипа и обложки и
  // заведомо меньше того, чем кладут сервер.
  limitInputPixels: 60_000_000,
  // Анимацию не разбираем: обложка — одна картинка, а сотня кадров означает
  // стократную работу на том же байтовом бюджете.
  animated: false,
  sequentialRead: true,
};

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

/**
 * Прямоугольник обрезки под нужные пропорции вокруг точки фокуса.
 *
 * Берётся максимальный прямоугольник нужных пропорций, который помещается в
 * изображение, и сдвигается так, чтобы точка фокуса оказалась в центре. У
 * краёв прямоугольник упирается в границу — иначе он вышел бы за пределы
 * картинки и обрезка упала бы.
 */
export function cropAround(
  width: number,
  height: number,
  box: { width: number; height: number },
  focusX: number,
  focusY: number,
): { left: number; top: number; width: number; height: number } {
  const targetRatio = box.width / box.height;
  let cropWidth = width;
  let cropHeight = Math.round(width / targetRatio);
  if (cropHeight > height) {
    cropHeight = height;
    cropWidth = Math.round(height * targetRatio);
  }
  cropWidth = Math.min(cropWidth, width);
  cropHeight = Math.min(cropHeight, height);

  const left = clamp(Math.round(focusX * width - cropWidth / 2), 0, width - cropWidth);
  const top = clamp(Math.round(focusY * height - cropHeight / 2), 0, height - cropHeight);
  return { left, top, width: cropWidth, height: cropHeight };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function uploadKey(projectId: string, kind: ProjectMediaKind): string {
  return `projects/${projectId}/media/${kind}/upload`;
}
function masterObjectKey(projectId: string, kind: ProjectMediaKind, mediaId: string): string {
  return `projects/${projectId}/media/${kind}/${mediaId}/master`;
}
function variantObjectKey(
  projectId: string,
  kind: ProjectMediaKind,
  mediaId: string,
  size: ProjectMediaSize,
): string {
  return `projects/${projectId}/media/${kind}/${mediaId}/${size}.webp`;
}

function view(projectId: string, row: MediaRow): ProjectMedia {
  const urls: Record<string, string> = {};
  for (const size of Object.keys(row.variants ?? {})) {
    urls[size] = `/v1/projects/${projectId}/media/${row.kind}/${size}`;
  }
  return {
    kind: row.kind,
    mime: row.mime,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    focusX: row.focus_x,
    focusY: row.focus_y,
    urls: urls as ProjectMedia['urls'],
    updatedAt: row.updated_at.toISOString(),
  };
}

interface MediaRow {
  kind: ProjectMediaKind;
  master_key: string;
  variants: Record<string, { key: string; width: number; height: number }> | null;
  mime: string;
  bytes: number;
  width: number;
  height: number;
  focus_x: number;
  focus_y: number;
  updated_at: Date;
}
