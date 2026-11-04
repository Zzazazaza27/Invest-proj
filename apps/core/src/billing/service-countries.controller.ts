import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import {
  ServiceCountryCodeSchema,
  ServiceCountrySchema,
  UpdateServiceCountryRequestSchema,
} from '@fifth/contracts';
import { z } from 'zod';
import { Ctx, Public, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ServiceCountriesService } from './service-countries.service';

/** Страны обслуживания: список публичен (регистрация). */
@Controller('service-countries')
export class ServiceCountriesController {
  constructor(private readonly countries: ServiceCountriesService) {}

  @Public()
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.countries.listPublic(ctx.traceId);
    return { items: items.map((c) => ServiceCountrySchema.parse(c)) };
  }
}

/** Страна обслуживания аккаунта — явный выбор пользователя. */
@Controller('me')
export class MeServiceCountryController {
  constructor(private readonly countries: ServiceCountriesService) {}

  @Put('service-country')
  async set(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(z.object({ code: ServiceCountryCodeSchema }), rawBody);
    return this.countries.setUserCountry(ctx, input.code);
  }
}

/** Администрирование стран (план 0.2 §0г, блок «Страны обслуживания»). */
@Roles('admin')
@Controller('admin/service-countries')
export class AdminServiceCountriesController {
  constructor(private readonly countries: ServiceCountriesService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.countries.listAll(ctx);
    return { items: items.map((c) => ServiceCountrySchema.parse(c)) };
  }

  /** Новая страна обслуживания — выключенной; включение — отдельно. */
  @Post()
  async create(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(z.object({ code: ServiceCountryCodeSchema }), rawBody);
    return ServiceCountrySchema.parse(await this.countries.createCountry(ctx, input.code));
  }

  @Patch(':code')
  async update(
    @Param('code') rawCode: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const code = parseOrThrow(ServiceCountryCodeSchema, rawCode);
    const input = parseOrThrow(UpdateServiceCountryRequestSchema, rawBody);
    return ServiceCountrySchema.parse(await this.countries.updateCountry(ctx, code, input));
  }
}
