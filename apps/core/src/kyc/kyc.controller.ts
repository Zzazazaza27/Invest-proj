import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  AddEntityMemberRequestSchema,
  BusinessEntitySchema,
  CreateEntityRequestSchema,
  EntityMemberSchema,
  KybVerificationSchema,
  KycDecisionRequestSchema,
  KycVerificationSchema,
  StartKybRequestSchema,
  StartKycRequestSchema,
  UuidSchema,
} from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { KycService } from './kyc.service';

/**
 * Верификация участников.
 *
 * Ни один маршрут здесь не помечен `@Public()`: анонимный доступ к контуру
 * комплаенса не имеет смысла ни в одном сценарии. Решения по заявкам отделены
 * ролью `admin` — это разделение обязанностей, а не удобство навигации.
 */
@Controller('kyc')
export class KycController {
  constructor(private readonly kyc: KycService) {}

  @Post('verifications')
  async startVerification(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(StartKycRequestSchema, rawBody);
    return KycVerificationSchema.parse(await this.kyc.startVerification(ctx, input));
  }

  @Get('verifications')
  async listVerifications(@Ctx() ctx: RequestContext) {
    const items = await this.kyc.listVerifications(ctx);
    return { items: items.map((v) => KycVerificationSchema.parse(v)) };
  }

  @Post('entities')
  async createEntity(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateEntityRequestSchema, rawBody);
    return BusinessEntitySchema.parse(await this.kyc.createEntity(ctx, input));
  }

  @Get('entities')
  async listEntities(@Ctx() ctx: RequestContext) {
    const items = await this.kyc.listEntities(ctx);
    return { items: items.map((e) => BusinessEntitySchema.parse(e)) };
  }

  @Post('entities/:id/members')
  async addMember(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const entityId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(AddEntityMemberRequestSchema, rawBody);
    return EntityMemberSchema.parse(await this.kyc.addMember(ctx, entityId, input));
  }

  @Post('entities/:id/kyb')
  async startKyb(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const entityId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(StartKybRequestSchema, rawBody);
    return KybVerificationSchema.parse(await this.kyc.startKyb(ctx, entityId, input.kind));
  }

  // ----------------------------------------------------------------- комплаенс

  @Roles('admin')
  @Get('queue')
  async queue(@Query('limit') rawLimit: unknown, @Ctx() ctx: RequestContext) {
    const limit = parseOrThrow(z.coerce.number().int().min(1).max(100).default(50), rawLimit ?? 50);
    const items = await this.kyc.reviewQueue(ctx, limit);
    return { items: items.map((v) => KycVerificationSchema.parse(v)) };
  }

  @Roles('admin')
  @Post('verifications/:id/decision')
  async decide(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(KycDecisionRequestSchema, rawBody);
    return KycVerificationSchema.parse(await this.kyc.decide(ctx, id, input));
  }

  @Roles('admin')
  @Post('kyb/:id/decision')
  async decideKyb(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(KycDecisionRequestSchema, rawBody);
    return KybVerificationSchema.parse(await this.kyc.decideKyb(ctx, id, input));
  }
}
