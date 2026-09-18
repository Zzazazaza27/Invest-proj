import { Body, Controller, Delete, Get, Param, Patch, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  AddProductLinkSchema,
  CreateProjectRequestSchema,
  ProjectFullSchema,
  ProjectLimitsSchema,
  ProjectMaterialSchema,
  ProjectSummarySchema,
  ProjectVersionSchema,
  RequestUploadSchema,
  UpdateProjectRequestSchema,
  UploadTicketSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ProjectsService } from './projects.service';

/**
 * Кабинет основателя.
 *
 * Ни один маршрут не публичен: всё, что здесь есть, — это работа с непубличной
 * карточкой. Публичная часть каталога живёт в отдельном контроллере и ходит в
 * БД под другой ролью.
 *
 * `projectId` всегда берётся из пути и проверяется как UUID до запроса: строка
 * из URL не должна доходить до слоя данных без разбора.
 */
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Roles('founder', 'admin')
  @Post()
  async create(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateProjectRequestSchema, rawBody);
    return ProjectFullSchema.parse(await this.projects.create(ctx, input));
  }

  @Get()
  async listMine(@Ctx() ctx: RequestContext) {
    const items = await this.projects.listMine(ctx);
    return { items: items.map((p) => ProjectSummarySchema.parse(p)) };
  }

  /** Лимит проектов аккаунта и его источник — до `:id`, иначе перехватит маршрут проекта. */
  @Get('limits')
  async limits(@Ctx() ctx: RequestContext) {
    return ProjectLimitsSchema.parse(await this.projects.projectLimits(ctx));
  }

  @Get(':id')
  async getOne(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ProjectFullSchema.parse(await this.projects.getOne(ctx, id));
  }

  @Roles('founder', 'admin')
  @Patch(':id')
  async update(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateProjectRequestSchema, rawBody);
    return ProjectFullSchema.parse(await this.projects.update(ctx, id, input));
  }

  @Roles('founder', 'admin')
  @Post(':id/submit')
  async submit(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ProjectVersionSchema.parse(await this.projects.submit(ctx, id));
  }

  /** История подач. Видимость определяет RLS, не роль в декораторе. */
  @Get(':id/versions')
  async listVersions(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.projects.listVersions(ctx, id);
    return { items: items.map((v) => ProjectVersionSchema.parse(v)) };
  }

  // ------------------------------------------------------------------ материалы

  @Get(':id/materials')
  async listMaterials(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.projects.listMaterials(ctx, id);
    return { items: items.map((m) => ProjectMaterialSchema.parse(m)) };
  }

  /**
   * Просмотр материала внутри платформы.
   *
   * `Content-Disposition: inline` — файл открывается во встроенном просмотрщике
   * браузера, а не сохраняется. Это не защита от копирования (её на клиенте не
   * существует: у того, кто видит документ, он уже есть), а честное поведение
   * интерфейса — «смотреть здесь», без кнопки «скачать».
   *
   * `X-Content-Type-Options: nosniff` обязателен: без него браузер угадывает
   * тип по содержимому и может выполнить чужой файл как HTML с нашего адреса.
   */
  @Get(':id/materials/:materialId/content')
  async materialContent(
    @Param('id') rawId: string,
    @Param('materialId') rawMaterialId: string,
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const materialId = parseOrThrow(UuidSchema, rawMaterialId);
    const file = await this.projects.getMaterialContent(ctx, id, materialId);
    void reply.header('Content-Type', file.contentType);
    void reply.header('Content-Disposition', `inline; filename="${file.filename}"`);
    void reply.header('X-Content-Type-Options', 'nosniff');
    // Документ проекта — не публичный ресурс: он не должен осесть в общих
    // кэшах между инвестором и следующим посетителем.
    void reply.header('Cache-Control', 'private, no-store');
    /*
      Встраивание разрешено СВОЕМУ origin и только здесь.
      Глобально ядро отдаёт `X-Frame-Options: DENY` и `frame-ancestors 'none'` —
      правильная защита от кликджекинга для страниц с действиями. Но просмотр
      документа — это ровно встраивание в собственный кабинет: с глобальными
      заголовками фрейм оставался пустым, а браузер писал «сайт не позволяет
      установить соединение» (проверено рендером, а не чтением кода).
      `SAMEORIGIN` и `frame-ancestors 'self'` открывают только свой домен;
      встроить документ к себе на страницу чужой сайт по-прежнему не может.
      Остальные директивы CSP оставлены запретительными: у PDF нет ни скриптов,
      ни форм, которым здесь было бы место.
    */
    void reply.header('X-Frame-Options', 'SAMEORIGIN');
    void reply.header(
      'Content-Security-Policy',
      "default-src 'none'; object-src 'none'; script-src 'none'; " +
        "form-action 'none'; frame-ancestors 'self'",
    );
    return reply.send(file.body);
  }

  @Roles('founder', 'admin')
  @Post(':id/materials/link')
  async addLink(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    // projectId берётся из пути, а не из тела: иначе один и тот же запрос имел
    // бы два источника адресата и разошёлся бы с проверкой прав.
    const input = parseOrThrow(AddProductLinkSchema, { ...asObject(rawBody), projectId: id });
    return ProjectMaterialSchema.parse(await this.projects.addProductLink(ctx, input));
  }

  @Roles('founder', 'admin')
  @Post(':id/materials/upload')
  async requestUpload(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(RequestUploadSchema, { ...asObject(rawBody), projectId: id });
    return UploadTicketSchema.parse(await this.projects.requestUpload(ctx, input));
  }

  // -------------------------------------------------------------------- листинг

  /**
   * Подтверждение загрузки. Без него материал остаётся намерением: билет мог
   * быть выдан и не использован, и показывать такую запись как материал —
   * вводить в заблуждение основателя и рецензента (SEC-14).
   */
  @Roles('founder', 'admin')
  @Post(':id/materials/:materialId/finalize')
  async finalizeUpload(
    @Param('id') rawId: string,
    @Param('materialId') rawMaterialId: string,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const materialId = parseOrThrow(UuidSchema, rawMaterialId);
    return ProjectMaterialSchema.parse(await this.projects.finalizeUpload(ctx, id, materialId));
  }

  @Roles('founder', 'admin')
  @Post(':id/listing')
  async publish(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ProjectFullSchema.parse(await this.projects.publishListing(ctx, id));
  }

  @Roles('founder', 'admin')
  @Delete(':id/listing')
  async unpublish(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ProjectFullSchema.parse(await this.projects.unpublishListing(ctx, id));
  }
}

/** Тело запроса может прийти чем угодно; до слияния с path-параметром это объект. */
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
