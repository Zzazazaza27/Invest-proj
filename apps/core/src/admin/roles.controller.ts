import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { RoleSchema, UuidSchema } from '@fifth/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { RolesService } from './roles.service';

/**
 * Управление ролями. Только `admin` и только над ЧУЖИМ аккаунтом —
 * самоповышение и самоблокировка закрыты в сервисе, а не полагаются на UI.
 */
@Roles('admin')
@Controller('admin/users/:id/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  async list(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return { items: await this.roles.list(ctx, id) };
  }

  @Post()
  async grant(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(z.object({ role: RoleSchema }), rawBody);
    return { items: await this.roles.grant(ctx, id, input.role) };
  }

  @Delete(':role')
  async revoke(
    @Param('id') rawId: string,
    @Param('role') rawRole: string,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const role = parseOrThrow(RoleSchema, rawRole);
    return { items: await this.roles.revoke(ctx, id, role) };
  }
}
