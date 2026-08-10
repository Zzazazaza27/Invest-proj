import { Controller, Get, Param, Post } from '@nestjs/common';
import { UuidSchema } from '@unicorn/contracts';
import { Ctx } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { AnalysisService } from './analysis.service';

/**
 * AI-анализ проекта.
 *
 * Ни один маршрут не помечен `@Public()`: паспорт и оценки видны только тем,
 * кому их открывает RLS — владельцу проекта, администратору и инвестору с
 * активной подпиской по опубликованному листингу (M006).
 *
 * Запуск анализа отдельно ограничен правом редактировать проект: считать чужой
 * проект по чужому запросу — это и расход ресурсов, и след в чужой истории.
 */
@Controller('projects')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post(':id/analysis')
  async run(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return this.analysis.run(ctx, id);
  }

  @Get(':id/passport')
  async passport(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return this.analysis.getPassport(ctx, id);
  }

  @Get(':id/readiness')
  async readiness(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return { items: await this.analysis.getReadiness(ctx, id) };
  }

  @Get(':id/roadmap')
  async roadmap(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return this.analysis.getRoadmap(ctx, id);
  }
}
