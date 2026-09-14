import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ActivateApplicationPolicyRequestSchema,
  ApplicationListSchema,
  ApplicationPolicyVersionSchema,
  ApplicationWithChecksSchema,
  CreateApplicationRequestSchema,
  InvestmentApplicationSchema,
  ProjectVersionSchema,
  UpdateApplicationRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ApplicationsService } from './applications.service';

/**
 * Заявки проекта в кабинете основателя.
 *
 * Список и создание — под проектом, остальное — по идентификатору заявки:
 * заявка принадлежит проекту, но живёт своей жизнью (несколько на проект,
 * свои версии, свой архив). Ни один маршрут не публичен; границу «своё/чужое»
 * держит RLS, а не параметр запроса.
 */
@Controller()
export class ApplicationsController {
  constructor(private readonly applications: ApplicationsService) {}

  /** Список заявок проекта вместе с остатком и потолками политики. */
  @Get('projects/:id/applications')
  async list(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    return ApplicationListSchema.parse(await this.applications.list(ctx, projectId));
  }

  @Roles('founder', 'admin')
  @Post('projects/:id/applications')
  async create(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(CreateApplicationRequestSchema, rawBody ?? {});
    return InvestmentApplicationSchema.parse(await this.applications.create(ctx, projectId, input));
  }

  @Get('applications/:id')
  async get(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ApplicationWithChecksSchema.parse(await this.applications.get(ctx, id));
  }

  /** Автосохранение черновика: частичное тело, `null` очищает поле. */
  @Roles('founder', 'admin')
  @Patch('applications/:id')
  async update(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateApplicationRequestSchema, rawBody);
    return ApplicationWithChecksSchema.parse(await this.applications.update(ctx, id, input));
  }

  @Roles('founder', 'admin')
  @Post('applications/:id/archive')
  async archive(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return InvestmentApplicationSchema.parse(await this.applications.archive(ctx, id));
  }

  /**
   * Подача: неизменяемый снимок версии, проекция в проект. Сезон не нужен;
   * подача в сезон — старый маршрут `POST /projects/:id/submit`.
   */
  @Roles('founder', 'admin')
  @Post('applications/:id/submit')
  async submit(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ProjectVersionSchema.parse(await this.applications.submit(ctx, id));
  }
}

/**
 * Политика ограничений основателя — настройка админки (план 0.2 §2.8).
 * Не тариф: подписка и сумма запроса здесь не участвуют.
 */
@Roles('admin')
@Controller('admin/application-policies')
export class AdminApplicationPoliciesController {
  constructor(private readonly applications: ApplicationsService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.applications.listPolicies(ctx);
    return { items: items.map((item) => ApplicationPolicyVersionSchema.parse(item)) };
  }

  /** Новая версия активируется сразу; прежняя остаётся в истории. */
  @Post()
  async activate(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(ActivateApplicationPolicyRequestSchema, rawBody);
    return ApplicationPolicyVersionSchema.parse(await this.applications.activatePolicy(ctx, input));
  }
}
