import { Body, Controller, Delete, Get, Param, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  FinalizeMediaSchema,
  MediaUploadTicketSchema,
  ProjectMediaKindSchema,
  ProjectMediaSchema,
  ProjectMediaSizeSchema,
  RequestMediaUploadSchema,
  UuidSchema,
} from '@fifth/contracts';
import { Ctx, Public, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import { AvailabilityService } from '../availability/availability.service';
import type { RequestContext } from '../db/unit-of-work';
import { ProjectMediaService } from './project-media.service';

/**
 * Логотип и обложка проекта (7.2).
 *
 * Изменяет только команда проекта; смотрит тот, кому виден сам проект. Второй
 * настройки видимости у изображения нет: она была бы вторым местом правды о
 * раскрытии, и однажды эти два места разошлись бы.
 */
@Controller('projects')
export class ProjectMediaController {
  constructor(
    private readonly media: ProjectMediaService,
    private readonly availability: AvailabilityService,
  ) {}

  @Roles('founder', 'admin')
  @Post(':id/media/upload')
  async requestUpload(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    // Группа «Файлы», изменение (4.11): недоступно — group_unavailable.
    await this.availability.assert('files', 'write');
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(RequestMediaUploadSchema, rawBody);
    return MediaUploadTicketSchema.parse(await this.media.requestUpload(ctx, id, input));
  }

  @Roles('founder', 'admin')
  @Post(':id/media/:kind/finalize')
  async finalize(
    @Param('id') rawId: string,
    @Param('kind') rawKind: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    // Группа «Файлы», изменение (4.11): недоступно — group_unavailable.
    await this.availability.assert('files', 'write');
    const id = parseOrThrow(UuidSchema, rawId);
    const kind = parseOrThrow(ProjectMediaKindSchema, rawKind);
    const input = parseOrThrow(FinalizeMediaSchema, rawBody ?? {});
    return ProjectMediaSchema.parse(await this.media.finalize(ctx, id, kind, input));
  }

  @Roles('founder', 'admin')
  @Delete(':id/media/:kind')
  async remove(
    @Param('id') rawId: string,
    @Param('kind') rawKind: string,
    @Ctx() ctx: RequestContext,
  ) {
    // Группа «Файлы», изменение (4.11): недоступно — group_unavailable.
    await this.availability.assert('files', 'write');
    const id = parseOrThrow(UuidSchema, rawId);
    const kind = parseOrThrow(ProjectMediaKindSchema, rawKind);
    await this.media.remove(ctx, id, kind);
    return { removed: kind };
  }

  /** Что есть у проекта. Виден тому, кому виден проект. */
  @Public()
  @Get(':id/media')
  async list(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.media.forProject(ctx, id);
    return { items: items.map((item) => ProjectMediaSchema.parse(item)) };
  }

  /**
   * Байты изображения — единственная дверь к нему.
   *
   * Маршрут публичный, но доступ решает не он: политика чтения пускает к
   * строке медиа только того, кому виден проект. Для постороннего закрытый и
   * несуществующий проект неотличимы — оба дают одинаковое «не найдено», без
   * названия и без подтверждения, что проект вообще есть.
   *
   * Кэширования нет: платформа ставит `no-store` на все ответы API, и для
   * изображений это правильно по той же причине, по какой правило заведено
   * вообще. Адрес один для всех, а доступ зависит от зрителя — общий кэш
   * однажды отдал бы картинку закрытого проекта соседу. Плата известна:
   * браузер перезапрашивает изображение. Если она станет заметной, включать
   * кэш можно будет только приватный и только для публичных проектов.
   */
  @Public()
  @Get(':id/media/:kind/:size')
  async variant(
    @Param('id') rawId: string,
    @Param('kind') rawKind: string,
    @Param('size') rawSize: string,
    @Ctx() ctx: RequestContext,
    @Res() reply: FastifyReply,
  ) {
    // Группа «Файлы», чтение (4.11): недоступно — group_unavailable.
    await this.availability.assert('files', 'read');
    const id = parseOrThrow(UuidSchema, rawId);
    const kind = parseOrThrow(ProjectMediaKindSchema, rawKind);
    const size = parseOrThrow(ProjectMediaSizeSchema, rawSize);
    const file = await this.media.variant(ctx, id, kind, size);
    await reply
      .header('content-type', file.contentType)
      .header('content-length', String(file.body.byteLength))
      // Платформа по умолчанию запрещает встраивать свои ответы на чужих
      // страницах (`Cross-Origin-Resource-Policy: same-origin`). Для API это
      // правильно, но изображение проекта существует ровно для того, чтобы его
      // показывали наши страницы.
      //
      // Взято МИНИМАЛЬНОЕ послабление — `same-site`, а не `cross-origin`:
      //
      //  • в рабочем размещении витрина, кабинеты и API за единой точкой входа,
      //    то есть один origin: `same-site` там не нужен, но и не мешает;
      //  • на стенде фронтенды слушают отдельные порты. Порт на «сайт» не
      //    влияет — `localhost:5173` и `localhost:4300` для браузера один сайт,
      //    и картинка грузится (проверено опытом, не предположением);
      //  • чужой сайт встроить изображение не может — ни публичное, ни
      //    закрытое.
      //
      // Оговорка про стенд: если открывать его по СЫРОМУ IP (`127.0.0.1`), у
      // адреса нет регистрируемого домена, браузер не может установить «тот же
      // сайт» и блокирует картинку. Это свойство адресации стенда, а не
      // продукта: проверки ходят по `localhost`.
      .header('cross-origin-resource-policy', 'same-site')
      .send(file.body);
  }
}
