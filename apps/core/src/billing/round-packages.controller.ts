import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  CloseRoundPackageRequestSchema,
  CreateRoundServiceRequestSchema,
  PublishRoundPackageRequestSchema,
  PublishRoundServiceOfferRequestSchema,
  RoundPackageSchema,
  RoundServiceOfferSchema,
  RoundServiceSchema,
  SetPackageAlternativeRequestSchema,
  UpdateRoundServiceRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { RoundPackagesService } from './round-packages.service';

/**
 * Настройка разовой оплаты запуска раунда (5.9.1).
 *
 * Только администратор и только настройка предложения. Покупки этим
 * контроллером не совершаются: продажи остаются выключенными до расчёта
 * стоимости и решений по коммерческим значениям.
 */
@Roles('admin')
@Controller('admin/round-services')
export class AdminRoundServicesController {
  constructor(private readonly packages: RoundPackagesService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.packages.listServices(ctx);
    return { items: items.map((s) => RoundServiceSchema.parse(s)) };
  }

  @Post()
  async create(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateRoundServiceRequestSchema, rawBody);
    return RoundServiceSchema.parse(await this.packages.createService(ctx, input));
  }

  @Patch(':id')
  async update(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(UpdateRoundServiceRequestSchema, rawBody);
    return RoundServiceSchema.parse(await this.packages.updateService(ctx, id, input));
  }
}

@Roles('admin')
@Controller('admin/round-packages')
export class AdminRoundPackagesController {
  constructor(private readonly packages: RoundPackagesService) {}

  /** Все версии, включая закрытые: история цены — часть настройки. */
  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.packages.listPackages(ctx);
    return { items: items.map((p) => RoundPackageSchema.parse(p)) };
  }

  @Post()
  async publish(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublishRoundPackageRequestSchema, rawBody);
    return RoundPackageSchema.parse(await this.packages.publishPackage(ctx, input));
  }

  /**
   * Назначить допустимую альтернативу. Несовпадение состава возвращается
   * предупреждением, а не отказом: решение принимает администратор.
   */
  @Post('alternatives')
  async addAlternative(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SetPackageAlternativeRequestSchema, rawBody);
    const result = await this.packages.addAlternative(ctx, input);
    return {
      items: result.packages.map((p) => RoundPackageSchema.parse(p)),
      warning: result.warning,
    };
  }

  @Post('alternatives/remove')
  async removeAlternative(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SetPackageAlternativeRequestSchema, rawBody);
    const items = await this.packages.removeAlternative(ctx, input);
    return { items: items.map((p) => RoundPackageSchema.parse(p)) };
  }

  @Post(':id/close')
  async close(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(CloseRoundPackageRequestSchema, rawBody);
    return RoundPackageSchema.parse(await this.packages.closePackage(ctx, id, input));
  }
}

@Roles('admin')
@Controller('admin/round-service-offers')
export class AdminRoundServiceOffersController {
  constructor(private readonly packages: RoundPackagesService) {}

  @Get()
  async list(@Ctx() ctx: RequestContext) {
    const items = await this.packages.listServiceOffers(ctx);
    return { items: items.map((o) => RoundServiceOfferSchema.parse(o)) };
  }

  @Post()
  async publish(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(PublishRoundServiceOfferRequestSchema, rawBody);
    return RoundServiceOfferSchema.parse(await this.packages.publishServiceOffer(ctx, input));
  }
}
