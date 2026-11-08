import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  AddSupportMessageRequestSchema,
  CreateSupportTicketRequestSchema,
  SupportMessageSchema,
  SupportTicketDetailSchema,
  SupportTicketSchema,
  UpdateSupportTicketRequestSchema,
  UuidSchema,
} from '@fifth/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import { requestKeyFrom } from '../db/request-keys';
import type { RequestContext } from '../db/unit-of-work';
import { SupportService } from './support.service';

/**
 * Поддержка: обращения и сообщения об ошибках.
 *
 * Все маршруты требуют входа — метки `@Public()` здесь нет ни на одном.
 * Анонимный приём обращений означал бы открытую наружу запись в базу без
 * какой-либо привязки к человеку: это спам-поверхность, которую пришлось бы
 * закрывать капчей, а капчи у платформы нет. Витрина анонимна и формы
 * обращения не показывает; тестировщик и пользователь работают в кабинете,
 * то есть уже вошли.
 *
 * Ни один маршрут не принимает идентификатор пользователя из запроса — он
 * всегда берётся из контекста аутентификации. Кто видит какие обращения,
 * решает политика RLS, а не параметр запроса.
 */
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('tickets')
  async open(
    @Body() rawBody: unknown,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') rawKey: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const input = parseOrThrow(CreateSupportTicketRequestSchema, rawBody);
    const key = requestKeyFrom(rawKey);
    // User-Agent берётся из ЗАГОЛОВКА, а не из тела: в баг-репорте нужен факт
    // о браузере, а не утверждение страницы о самой себе.
    const userAgent = request.headers['user-agent'];
    const ticket = await this.support.open(
      ctx,
      {
        ...input,
        userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      },
      key,
    );
    return SupportTicketDetailSchema.parse(ticket);
  }

  @Get('tickets')
  async list(@Query('limit') rawLimit: string | undefined, @Ctx() ctx: RequestContext) {
    const limit = parseOrThrow(z.coerce.number().int().min(1).max(100).default(50), rawLimit ?? 50);
    const items = await this.support.list(ctx, limit);
    return { items: items.map((item) => SupportTicketSchema.parse(item)) };
  }

  @Get('tickets/:id')
  async detail(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return SupportTicketDetailSchema.parse(await this.support.detail(ctx, id));
  }

  @Post('tickets/:id/messages')
  async reply(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Headers('idempotency-key') rawKey: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(AddSupportMessageRequestSchema, rawBody);
    const key = requestKeyFrom(rawKey);
    return SupportMessageSchema.parse(await this.support.reply(ctx, id, input.body, key));
  }

  /**
   * Взять в работу, вернуть в работу, закрыть.
   *
   * Право на этот маршрут не проверяется декоратором роли, и это осознанно:
   * его проверяет политика `support_tickets_staff` в самой БД. Проверка в двух
   * местах разошлась бы при первом же изменении, и разошлась бы молча.
   */
  @Patch('tickets/:id')
  async update(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateSupportTicketRequestSchema, rawBody);
    return SupportTicketDetailSchema.parse(await this.support.update(ctx, id, input));
  }
}
