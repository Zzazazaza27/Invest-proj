import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import {
  ExcludeAccessRequestSchema,
  GrantAccessRequestSchema,
  ProjectAccessEntrySchema,
  ProjectAccessListSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ProjectAccessService } from './project-access.service';

/**
 * Разрешения выбранных получателей (5.8).
 *
 * Маршруты — команде проекта и администратору; кто именно является командой,
 * решает RLS, поэтому посторонний получает 404 на первом же чтении проекта.
 * Отзыв — `DELETE`: закрытие доступа, а не удаление истории (в БД
 * проставляется `revoked_at`).
 */
@Controller('projects/:projectId/access')
export class ProjectAccessController {
  constructor(private readonly access: ProjectAccessService) {}

  @Roles('founder', 'admin')
  @Get()
  async list(@Param('projectId') rawId: string, @Ctx() ctx: RequestContext) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    return ProjectAccessListSchema.parse(await this.access.list(ctx, projectId));
  }

  @Roles('founder', 'admin')
  @Post('grants')
  async grant(
    @Param('projectId') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(GrantAccessRequestSchema, rawBody);
    return ProjectAccessEntrySchema.parse(await this.access.grant(ctx, projectId, input));
  }

  @Roles('founder', 'admin')
  @Delete('grants/:grantId')
  @HttpCode(204)
  async revokeGrant(
    @Param('projectId') rawId: string,
    @Param('grantId') rawGrantId: string,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const grantId = parseOrThrow(UuidSchema, rawGrantId);
    await this.access.revokeGrant(ctx, projectId, grantId);
  }

  @Roles('founder', 'admin')
  @Post('exclusions')
  async exclude(
    @Param('projectId') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(ExcludeAccessRequestSchema, rawBody);
    return ProjectAccessEntrySchema.parse(await this.access.exclude(ctx, projectId, input));
  }

  @Roles('founder', 'admin')
  @Delete('exclusions/:exclusionId')
  @HttpCode(204)
  async revokeExclusion(
    @Param('projectId') rawId: string,
    @Param('exclusionId') rawExclusionId: string,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
    const projectId = parseOrThrow(UuidSchema, rawId);
    const exclusionId = parseOrThrow(UuidSchema, rawExclusionId);
    await this.access.revokeExclusion(ctx, projectId, exclusionId);
  }
}
