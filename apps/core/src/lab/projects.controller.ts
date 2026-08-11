import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  AddProductLinkSchema,
  CreateProjectRequestSchema,
  ProjectFullSchema,
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
