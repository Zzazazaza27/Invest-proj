import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import {
  CreateServiceAccountRequestSchema,
  ServiceAccountSchema,
  ServiceAccountWithSecretSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { IntegrationService } from './integration.service';

/**
 * Управление доступом внешних систем. Только `admin`: выдача клиента с
 * `deals:read` — это решение о том, кто видит агрегаты сделок платформы.
 *
 * Секрет возвращается ровно один раз — при создании и при ротации. Хранится
 * только его Argon2id-хеш, поэтому «показать ещё раз» невозможно by design, а
 * не по забывчивости: единственный способ восстановить доступ — ротация.
 */
@Roles('admin')
@Controller('admin/service-accounts')
export class ServiceAccountsController {
  constructor(private readonly integration: IntegrationService) {}

  @Post()
  async create(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateServiceAccountRequestSchema, rawBody);
    return ServiceAccountWithSecretSchema.parse(
      await this.integration.createServiceAccount(ctx, input),
    );
  }

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.integration.listServiceAccounts(ctx);
    return { items: items.map((item) => ServiceAccountSchema.parse(item)) };
  }

  @Post(':id/rotation')
  async rotate(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return ServiceAccountWithSecretSchema.parse(await this.integration.rotateSecret(ctx, id));
  }

  /**
   * Приостановка и возобновление доступа внешней системы.
   *
   * Без этого маршрута статус аккаунта было НЕЧЕМ изменить, а значит и проверка
   * статуса при выдаче токена ничего не давала бы: приостановка существовала
   * только как значение в колонке.
   */
  @Post(':id/status')
  async setStatus(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(z.object({ status: z.enum(['active', 'suspended']) }), rawBody);
    return ServiceAccountSchema.parse(
      await this.integration.setServiceAccountStatus(ctx, id, input.status),
    );
  }
}
