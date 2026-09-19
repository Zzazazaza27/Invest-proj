import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import {
  AddExpertNoteRequestSchema,
  AssignmentDecisionRequestSchema,
  CreateAssignmentsRequestSchema,
  DecideConsensusRequestSchema,
  DeclareConflictRequestSchema,
  ExpertAssignmentSchema,
  ExpertConflictSchema,
  ExpertHistoryEntrySchema,
  ExpertNoteSchema,
  ExpertReviewSchema,
  ProjectReviewAssignmentSchema,
  ResolveConflictRequestSchema,
  ReviewConsensusSchema,
  SubmitReviewRequestSchema,
  UuidSchema,
  WithdrawAssignmentRequestSchema,
} from '@unicorn/contracts';
import { Ctx, Roles } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { ExpertsService } from './experts.service';

/**
 * Экспертный совет.
 *
 * Роли разведены жёстко: эксперт работает только со своими назначениями,
 * организатор — с составом рецензентов и решением. Ни один маршрут не
 * позволяет эксперту оценить проект, на который его не назначили, и ни один не
 * позволяет организатору написать рецензию за эксперта.
 */
@Controller('experts')
export class ExpertsController {
  constructor(private readonly experts: ExpertsService) {}

  @Roles('expert')
  @Get('assignments')
  async myAssignments(@Ctx() ctx: RequestContext) {
    const items = await this.experts.myAssignments(ctx);
    return { items: items.map((item) => ExpertAssignmentSchema.parse(item)) };
  }

  @Roles('admin', 'organizer')
  @Post('assignments')
  async assign(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(CreateAssignmentsRequestSchema, rawBody);
    const items = await this.experts.assign(ctx, input);
    return { items: items.map((item) => ExpertAssignmentSchema.parse(item)) };
  }

  /** Кто назначен на оценку этого проекта и чем это кончилось. */
  @Roles('admin', 'organizer')
  @Get('projects/:id/assignments')
  async projectAssignments(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.experts.projectAssignments(ctx, id);
    return { items: items.map((item) => ProjectReviewAssignmentSchema.parse(item)) };
  }

  /**
   * Снять назначение на оценку. Поданную рецензию не трогает — и назначение с
   * поданной рецензией снять нельзя вовсе.
   */
  @Roles('admin', 'organizer')
  @Post('assignments/:id/withdraw')
  async withdraw(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(WithdrawAssignmentRequestSchema, rawBody);
    return ProjectReviewAssignmentSchema.parse(
      await this.experts.withdrawAssignment(ctx, id, input.reason),
    );
  }

  @Roles('expert')
  @Post('assignments/:id/decision')
  async decide(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(AssignmentDecisionRequestSchema, rawBody);
    return ExpertAssignmentSchema.parse(
      await this.experts.decideAssignment(ctx, id, input.decision),
    );
  }

  @Roles('expert')
  @Post('reviews')
  async submitReview(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(SubmitReviewRequestSchema, rawBody);
    return ExpertReviewSchema.parse(await this.experts.submitReview(ctx, input));
  }

  /**
   * Пересмотр собственной рецензии.
   *
   * Не второй способ подать рецензию: маршрут работает только там, где она уже
   * есть, и только пока по проекту не принято решение консенсуса. Предел
   * держит триггер в БД — здесь он не дублируется, чтобы две проверки не
   * разошлись.
   */
  @Roles('expert')
  @Patch('assignments/:id/review')
  async reviseReview(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const assignmentId = parseOrThrow(UuidSchema, rawId);
    // Схема подачи без идентификатора назначения: он в пути, и принимать его
    // ещё и в теле означало бы два источника правды об одном.
    const input = parseOrThrow(SubmitReviewRequestSchema.omit({ assignmentId: true }), rawBody);
    return ExpertReviewSchema.parse(await this.experts.reviseReview(ctx, assignmentId, input));
  }

  @Roles('expert')
  @Post('assignments/:id/notes')
  async addNote(@Param('id') rawId: string, @Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const assignmentId = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(AddExpertNoteRequestSchema, rawBody);
    return ExpertNoteSchema.parse(await this.experts.addNote(ctx, assignmentId, input.body));
  }

  @Roles('expert', 'admin', 'organizer')
  @Get('assignments/:id/notes')
  async listNotes(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const assignmentId = parseOrThrow(UuidSchema, rawId);
    const items = await this.experts.listNotes(ctx, assignmentId);
    return { items: items.map((item) => ExpertNoteSchema.parse(item)) };
  }

  /**
   * История рассмотрения. Читается из журнала событий, а не из отдельной
   * таблицы: журнал уже пишет каждое действие и хеш-сцеплен.
   */
  @Roles('expert', 'admin', 'organizer')
  @Get('assignments/:id/history')
  async history(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const assignmentId = parseOrThrow(UuidSchema, rawId);
    const items = await this.experts.history(ctx, assignmentId);
    return { items: items.map((item) => ExpertHistoryEntrySchema.parse(item)) };
  }

  @Roles('admin', 'organizer')
  @Get('projects/:id/reviews')
  async projectReviews(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const result = await this.experts.projectReviews(ctx, id);
    return {
      items: result.items.map((item) => ExpertReviewSchema.parse(item)),
      discrepancyScore: result.discrepancyScore,
    };
  }

  @Roles('expert')
  @Post('conflicts')
  async declareConflict(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(DeclareConflictRequestSchema, rawBody);
    return ExpertConflictSchema.parse(await this.experts.declareConflict(ctx, input));
  }

  @Roles('admin', 'organizer')
  @Post('conflicts/:id/resolution')
  async resolveConflict(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(ResolveConflictRequestSchema, rawBody);
    return ExpertConflictSchema.parse(
      await this.experts.resolveConflict(ctx, id, input.resolution),
    );
  }

  @Roles('admin', 'organizer')
  @Get('projects/:id/conflicts')
  async listConflicts(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    const items = await this.experts.listConflicts(ctx, id);
    return { items: items.map((item) => ExpertConflictSchema.parse(item)) };
  }

  /** Финальное решение фиксирует человек — идентификатор берётся из контекста. */
  @Roles('admin', 'organizer')
  @Post('consensus')
  async decideConsensus(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(DecideConsensusRequestSchema, rawBody);
    return ReviewConsensusSchema.parse(await this.experts.decideConsensus(ctx, input));
  }
}
