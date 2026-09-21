import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { Ctx, Public, Roles, AuthInfo, AccessCtx } from '../auth/guards';
import type { RequestContext } from '../db/unit-of-work';
import type { ResolvedContext } from '../auth/access-context.service';
import { errors } from '../common/errors';
import { TestingSessionsService } from './testing-sessions.service';

/**
 * Тестовые сессии: управление из админки и панель в тестовой вкладке.
 *
 * РАЗДЕЛЕНИЕ, КОТОРОЕ ЗДЕСЬ ВАЖНО. Управление сессией — административное
 * действие: оно идёт под обычной админской сессией и БЕЗ заголовка контекста.
 * Панель в тестовой вкладке — единственное, что читается ПОД контекстом.
 * Если перепутать, «завершить просмотр» окажется действием просматриваемого
 * пользователя, а не администратора.
 */

const CreateSessionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  source: z.enum(['manual', 'automated']).optional(),
  scenarioId: z.string().trim().min(1).max(120).nullish(),
  codeVersion: z.string().trim().min(1).max(80).nullish(),
  withStandardCast: z.boolean().optional(),
});

const FinishSchema = z.object({
  result: z.enum(['unknown', 'passed', 'failed']).optional(),
});

const StepSchema = z.object({
  ordinal: z.number().int().positive(),
  name: z.string().trim().min(1).max(200),
  status: z.enum(['passed', 'failed', 'skipped']),
  actor: z.string().trim().min(1).max(80).nullish(),
  expected: z.string().max(2000).nullish(),
  actual: z.string().max(2000).nullish(),
});

const OpenContextSchema = z.union([
  z.object({ kind: z.literal('participant'), userId: z.string().uuid() }),
  z.object({ kind: z.literal('guest') }),
]);

const OpenUserViewSchema = z.object({ userId: z.string().uuid() });

@Controller()
export class TestingController {
  constructor(private readonly sessions: TestingSessionsService) {}

  // --------------------------------------------------------- админ: сессии

  @Post('admin/testing/sessions')
  @Roles('admin')
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    const input = CreateSessionSchema.parse(body);
    return this.sessions.create(ctx, input);
  }

  @Get('admin/testing/sessions')
  @Roles('admin')
  async list(@Ctx() ctx: RequestContext) {
    return { sessions: await this.sessions.list(ctx) };
  }

  @Get('admin/testing/sessions/:id')
  @Roles('admin')
  async card(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.sessions.card(ctx, id);
  }

  @Post('admin/testing/sessions/:id/steps')
  @Roles('admin')
  @HttpCode(200)
  async addStep(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const input = StepSchema.parse(body);
    await this.sessions.addStep(ctx, id, input);
    return { ok: true };
  }

  @Post('admin/testing/sessions/:id/finish')
  @Roles('admin')
  @HttpCode(200)
  async finish(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    const input = FinishSchema.parse(body ?? {});
    await this.sessions.finish(ctx, id, input.result ?? 'unknown');
    return { ok: true };
  }

  @Post('admin/testing/sessions/:id/resume')
  @Roles('admin')
  @HttpCode(200)
  async resume(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.sessions.resume(ctx, id);
    return { ok: true };
  }

  /** Показ состава уборки. Отдельным запросом: удаление без показа не бывает. */
  @Get('admin/testing/sessions/:id/cleanup')
  @Roles('admin')
  async cleanupPreview(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return { plan: await this.sessions.cleanupPreview(ctx, id) };
  }

  @Post('admin/testing/sessions/:id/cleanup')
  @Roles('admin')
  @HttpCode(200)
  async cleanup(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.sessions.cleanup(ctx, id);
  }

  // ------------------------------------------------------ админ: контексты

  @Post('admin/testing/sessions/:id/contexts')
  @Roles('admin')
  @HttpCode(200)
  async openContext(
    @Ctx() ctx: RequestContext,
    @AuthInfo() auth: { tokenId: string | null },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = OpenContextSchema.parse(body);
    return this.sessions.openSessionContext(ctx, auth.tokenId, id, input);
  }

  /**
   * Просмотр кабинета рабочего пользователя — другой режим, другое
   * полномочие, другие правила. Поэтому и маршрут отдельный: общий маршрут
   * с тестовой сессией однажды получил бы общую проверку.
   */
  @Post('admin/testing/user-views')
  @Roles('admin')
  @HttpCode(200)
  async openUserView(
    @Ctx() ctx: RequestContext,
    @AuthInfo() auth: { tokenId: string | null },
    @Body() body: unknown,
  ) {
    const input = OpenUserViewSchema.parse(body);
    return this.sessions.openUserView(ctx, auth.tokenId, input.userId);
  }

  @Delete('admin/testing/contexts/:id')
  @Roles('admin')
  @HttpCode(200)
  async closeContext(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    await this.sessions.closeContext(ctx, id);
    return { ok: true };
  }

  // ------------------------------------------------- панель в тестовой вкладке

  /**
   * Что показывать в плашке. Читается ПОД контекстом.
   *
   * Маршрут публичный намеренно: гостевой контекст обрабатывается как
   * неавторизованный запрос, и требование аутентификации сделало бы панель
   * недоступной ровно там, где она нужнее всего — на гостевой странице.
   * Сведения здесь не секретны: имя участника, вид режима и срок.
   */
  @Get('testing/context/current')
  @Public()
  async current(@AccessCtx() context: ResolvedContext | undefined) {
    if (!context) throw errors.notFound({ what: 'access_context' });
    return {
      id: context.id,
      kind: context.kind,
      sessionId: context.sessionId,
      subjectUserId: context.subjectUserId,
      readOnly: context.kind === 'readonly',
    };
  }
}
