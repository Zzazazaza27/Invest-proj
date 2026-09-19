import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { IdempotencyKeySchema, MoneyAmountSchema, UuidSchema } from '@unicorn/contracts';
import { z } from 'zod';
import { Ctx, Roles, StepUp } from '../auth/guards';
import { parseOrThrow } from '../common/validation';
import type { RequestContext } from '../db/unit-of-work';
import { InvestmentsService } from './investments.service';

/**
 * Регулируемый инвестиционный контур.
 *
 * Контур выключен фичефлагом до включения оператора в реестр ОИП: маршруты
 * существуют и проверены, но отвечают «функция недоступна». Это состояние
 * продукта, а не незавершённая работа.
 *
 * Приём предложения и подписание договора помечены `@StepUp()` —
 * Architect_Launch §7 требует подтверждения вторым фактором на этих операциях.
 * Локальный адаптер аутентификации второго фактора не выдаёт, поэтому в dev эти
 * маршруты отвечают `step_up_required`: честнее, чем тихо пропускать.
 */
@Controller('investments')
export class InvestmentsController {
  constructor(private readonly investments: InvestmentsService) {}

  @Roles('founder', 'admin')
  @Post('offers')
  async createOffer(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(
      z.object({
        projectId: UuidSchema,
        issuerEntityId: UuidSchema,
        instrumentType: z.enum(['loan', 'security', 'utility_digital_right', 'dfa']),
        targetAmount: MoneyAmountSchema,
        minInvestment: MoneyAmountSchema,
        terms: z.record(z.string(), z.unknown()).default({}),
        opensAt: z.iso.datetime({ offset: true }).optional(),
        closesAt: z.iso.datetime({ offset: true }).optional(),
      }),
      rawBody,
    );
    return this.investments.createOffer(ctx, input);
  }

  @Roles('admin')
  @Post('offers/:id/publish')
  async publishOffer(
    @Param('id') rawId: string,
    @Body() rawBody: unknown,
    @Ctx() ctx: RequestContext,
  ) {
    const id = parseOrThrow(UuidSchema, rawId);
    const input = parseOrThrow(
      z.object({ opensAt: z.iso.datetime({ offset: true }).optional() }),
      rawBody ?? {},
    );
    return this.investments.publishOffer(ctx, id, input.opensAt);
  }

  @Get('offers')
  async listOffers(@Ctx() ctx: RequestContext) {
    return { items: await this.investments.listOffers(ctx) };
  }

  @StepUp()
  @Roles('investor')
  @Post('agreements')
  async acceptOffer(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(
      z.object({
        offerId: UuidSchema,
        amount: MoneyAmountSchema,
        idempotencyKey: IdempotencyKeySchema,
      }),
      rawBody,
    );
    return this.investments.acceptOffer(ctx, input);
  }

  @StepUp()
  @Post('agreements/:id/signature')
  async sign(@Param('id') rawId: string, @Ctx() ctx: RequestContext) {
    const id = parseOrThrow(UuidSchema, rawId);
    return this.investments.signAgreement(ctx, id);
  }

  @Get('agreements')
  async listAgreements(@Ctx() ctx: RequestContext) {
    return { items: await this.investments.listAgreements(ctx) };
  }

  /**
   * Подтверждение первого транша по банковскому событию.
   *
   * Роль `admin` — временная форма приёма события: пока нет интеграции с банком,
   * выписку заносит оператор. Клиентским запросом инвестора это быть не может
   * ни при каких условиях (Architect_Launch §7).
   */
  @Roles('admin')
  @Post('tranches/confirm')
  async confirmTranche(@Body() rawBody: unknown, @Ctx() ctx: RequestContext) {
    const input = parseOrThrow(
      z.object({
        agreementId: UuidSchema,
        bankTransactionRef: z.string().trim().min(4).max(120),
        amount: MoneyAmountSchema,
        bookedAt: z.iso.datetime({ offset: true }),
        /** Отпечаток банковской выписки: доказательство происхождения события. */
        statementSha256: z.string().regex(/^[0-9a-f]{64}$/, 'ожидается sha256 в hex'),
      }),
      rawBody,
    );
    return this.investments.confirmTranche(ctx, input);
  }
}
