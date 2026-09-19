import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { uuidv7 } from '@unicorn/contracts';
import { AppError, errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { S3Service, putObject } from '../storage/s3.service';

/**
 * Регулируемый инвестиционный контур.
 *
 * Весь модуль закрыт фичефлагом `investments.enabled`, и флаг выключен: контур
 * не включается до включения оператора в реестр ОИП Банка России и согласования
 * Правил платформы (гейт A, Architect_Launch §5.5, §9). Код существует и
 * проверяется, но по умолчанию отвечает «функция недоступна» — это не
 * заглушка, а осознанное состояние продукта.
 *
 * Три инварианта, которые здесь важнее всего и живут НЕ только в этом файле:
 *
 *  1. Оператор не является стороной договора. Стороны — инвестор и ЛПИ;
 *     платформа лишь фиксирует условия и вознаграждение.
 *  2. Первый транш подтверждается банковским событием номинального счёта, а не
 *     запросом клиента. Поэтому подтверждение принимает отдельный маршрут с
 *     ролью администратора и обязательной ссылкой на банковскую операцию.
 *  3. Вознаграждение начисляется ровно один раз, атомарно с переходом договора
 *     в силу. Это делает команда БД `billing.confirm_first_tranche`, а не
 *     сервисный слой: повторить её невозможно (UNIQUE на договор), и она же
 *     обеспечивает идемпотентность повторной доставки банковского события.
 */

/** Допустимые способы инвестирования. Включаются отдельными флагами. */
const INSTRUMENT_FLAGS: Record<string, string> = {
  loan: 'investments.instrument.loan',
  security: 'investments.instrument.security',
  utility_digital_right: 'investments.instrument.utility_digital_right',
  dfa: 'investments.instrument.dfa',
};

@Injectable()
export class InvestmentsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly crypto: CryptoService,
    private readonly s3: S3Service,
  ) {}

  // ------------------------------------------------------------ предложения

  async createOffer(
    ctx: RequestContext,
    input: {
      projectId: string;
      issuerEntityId: string;
      instrumentType: string;
      targetAmount: string;
      minInvestment: string;
      terms: Record<string, unknown>;
      opensAt?: string;
      closesAt?: string;
    },
  ): Promise<OfferView> {
    const offerId = uuidv7();

    return mapInvestmentErrors(async () => {
      await this.assertContourEnabled(ctx);
      await this.assertInstrumentAllowed(ctx, input.instrumentType);

      // Документ формирует сервер: подпись сторон должна относиться ровно к
      // тем условиям, которые зафиксировала платформа.
      const document = renderOfferDocument({ ...input, offerId });
      const sha256 = createHash('sha256').update(document).digest();
      const sealed = this.crypto.seal('investment_documents', document, `offer:${offerId}`);
      const key = `investments/offers/${offerId}.txt`;

      if (!this.s3.isConfigured) throw errors.featureDisabled('investment_documents');

      // Право размещать предложение проверяется ДО записи в хранилище.
      // Прежний порядок (сначала putObject, потом проверка) оставлял объект
      // в S3 после отказа: сирота, которую уборщик не найдёт — он работает
      // только по lab.project_materials (MEDIUM внешнего аудита №2).
      //
      // Проверка идёт в контексте пользователя — под его RLS. Сама запись
      // ниже идёт сервисной ролью: регулируемый контур доступен на запись
      // только ей (политики offers_service_write, M005), и это не обходной
      // путь, а заложенное разделение — пользовательская роль не должна уметь
      // писать в реестр договоров даже при ошибке в коде.
      await this.db.readOnly(ctx, async (tx) => {
        await this.assertIssuerEligible(tx, input.projectId, input.issuerEntityId, ctx.userId!);
      });

      await putObject({ key, body: sealed.ciphertext, contentType: 'application/octet-stream' });

      return this.db.asServiceRole('app_investments', { traceId: ctx.traceId }, async (tx) => {
        const rules = await tx.query<{ rules_version: string }>(
          `SELECT rules_version FROM billing.fee_schedules
            WHERE code = 'operator_success_fee'
              AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
            ORDER BY version DESC LIMIT 1`,
        );
        const rulesVersion = rules.rows[0]?.rules_version;
        if (!rulesVersion) throw errors.internal({ reason: 'no active fee schedule' });

        await tx.query(
          `INSERT INTO investments.investment_offers
             (id, project_id, issuer_entity_id, instrument_type, rules_version,
              target_amount, min_investment, terms_jsonb,
              document_s3_key, document_sha256, document_wrapped_dek,
              status, opens_at, closes_at, created_by)
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::numeric, $8::jsonb,
                   $9, $10, $11, 'draft', $12::timestamptz, $13::timestamptz, $14)`,
          [
            offerId,
            input.projectId,
            input.issuerEntityId,
            input.instrumentType,
            rulesVersion,
            input.targetAmount,
            input.minInvestment,
            JSON.stringify(input.terms),
            key,
            sha256,
            sealed.wrappedDek,
            input.opensAt ?? null,
            input.closesAt ?? null,
            ctx.userId,
          ],
        );

        await this.audit.emit(tx, {
          verb: 'investment.offer.created',
          actorId: ctx.userId,
          actorRole: 'founder',
          subjectType: 'investment_offer',
          subjectId: offerId,
          context: {
            projectId: input.projectId,
            instrumentType: input.instrumentType,
            targetAmount: input.targetAmount,
          },
          traceId: ctx.traceId,
        });

        return this.readOffer(tx, offerId);
      });
    });
  }

  /** Публикация предложения комплаенсом. Отдельное решение, не действие ЛПИ. */
  async publishOffer(ctx: RequestContext, offerId: string, opensAt?: string): Promise<OfferView> {
    return mapInvestmentErrors(async () => {
      await this.assertContourEnabled(ctx);
      return this.db.asServiceRole('app_investments', { traceId: ctx.traceId }, async (tx) => {
        const offer = await this.readOffer(tx, offerId);
        if (offer.status === 'published') return offer;
        if (offer.status !== 'draft' && offer.status !== 'compliance_review') {
          throw errors.stateTransition('Предложение в этом статусе публиковать нельзя');
        }

        await tx.query(
          `UPDATE investments.investment_offers
              SET status = 'published',
                  opens_at = COALESCE($2::timestamptz, opens_at, now()),
                  updated_at = now()
            WHERE id = $1`,
          [offerId, opensAt ?? null],
        );

        await this.audit.record(tx, {
          verb: 'investment.offer.published',
          actorId: ctx.userId,
          actorRole: 'admin',
          aggregateType: 'investment_offer',
          aggregateId: offerId,
          aggregateVersion: 1,
          payload: { offerId, projectId: offer.projectId },
          traceId: ctx.traceId,
        });

        return this.readOffer(tx, offerId);
      });
    });
  }

  async listOffers(ctx: RequestContext): Promise<OfferView[]> {
    await this.assertContourEnabled(ctx);
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<OfferRow>(
        `${OFFER_SELECT} ORDER BY o.created_at DESC LIMIT 100`,
      );
      return rows.map(mapOffer);
    });
  }

  // --------------------------------------------------------------- договоры

  /**
   * Принятие предложения инвестором.
   *
   * `idempotencyKey` обязателен и уникален в БД: повторная отправка формы не
   * создаёт второй договор на те же деньги. Проверки лимитов, статуса
   * предложения и запрета самосделки живут в триггерах — здесь они только
   * переводятся в понятные ошибки.
   */
  async acceptOffer(
    ctx: RequestContext,
    input: { offerId: string; amount: string; idempotencyKey: string },
  ): Promise<AgreementView> {
    return mapInvestmentErrors(async () => {
      await this.assertContourEnabled(ctx);
      const agreementId = uuidv7();

      // Ключ идемпотентности принадлежит инвестору (M019): и запрос, и
      // уникальный индекс считают его в паре с investor_id. Фильтр по
      // пользователю здесь не дублирует RLS без нужды — он делает намерение
      // явным в самом запросе, а не только в политике.
      const existing = await this.db.readOnly(ctx, async (tx) => {
        const { rows } = await tx.query<AgreementRow>(
          `${AGREEMENT_SELECT} WHERE a.investor_id = $1 AND a.idempotency_key = $2`,
          [ctx.userId, input.idempotencyKey],
        );
        return rows[0] ?? null;
      });
      if (existing) return mapAgreement(existing);

      const document = renderAgreementDocument({ ...input, agreementId, investorId: ctx.userId! });
      const sha256 = createHash('sha256').update(document).digest();
      const sealed = this.crypto.seal('investment_documents', document, `agreement:${agreementId}`);
      const key = `investments/agreements/${agreementId}.txt`;
      if (!this.s3.isConfigured) throw errors.featureDisabled('investment_documents');
      await putObject({ key, body: sealed.ciphertext, contentType: 'application/octet-stream' });

      return this.db.asServiceRole('app_investments', { traceId: ctx.traceId }, async (tx) => {
        const fee = await tx.query<{ id: string }>(
          `SELECT id FROM billing.fee_schedules
            WHERE code = 'operator_success_fee'
              AND valid_from <= now() AND (valid_to IS NULL OR valid_to > now())
            ORDER BY version DESC LIMIT 1`,
        );
        const feeScheduleId = fee.rows[0]?.id;
        if (!feeScheduleId) throw errors.internal({ reason: 'no active fee schedule' });

        await tx.query(
          `INSERT INTO investments.investment_agreements
             (id, offer_id, investor_id, contract_amount, fee_schedule_id,
              document_s3_key, document_sha256, document_wrapped_dek,
              status, idempotency_key)
           VALUES ($1, $2, $3, $4::numeric, $5, $6, $7, $8, 'pending_signatures', $9)`,
          [
            agreementId,
            input.offerId,
            ctx.userId,
            input.amount,
            feeScheduleId,
            key,
            sha256,
            sealed.wrappedDek,
            input.idempotencyKey,
          ],
        );

        await this.audit.emit(tx, {
          verb: 'investment.agreement.created',
          actorId: ctx.userId,
          actorRole: 'investor',
          subjectType: 'investment_agreement',
          subjectId: agreementId,
          context: { offerId: input.offerId, amount: input.amount },
          traceId: ctx.traceId,
        });

        return this.readAgreement(tx, agreementId);
      });
    });
  }

  /** Подпись стороны. Когда подписали обе — договор переходит в `signed`. */
  async signAgreement(ctx: RequestContext, agreementId: string): Promise<AgreementView> {
    return mapInvestmentErrors(async () => {
      await this.assertContourEnabled(ctx);
      return this.db.asServiceRole('app_investments', { traceId: ctx.traceId }, async (tx) => {
        const { rows } = await tx.query<{
          investor_id: string;
          issuer_owner: string | null;
          status: string;
          investor_signed_at: Date | null;
          issuer_signed_at: Date | null;
        }>(
          `SELECT a.investor_id, a.status, a.investor_signed_at, a.issuer_signed_at,
                  (SELECT fp.user_id FROM lab.founders_projects fp
                    WHERE fp.project_id = o.project_id AND fp.role = 'owner') AS issuer_owner
             FROM investments.investment_agreements a
             JOIN investments.investment_offers o ON o.id = a.offer_id
            WHERE a.id = $1`,
          [agreementId],
        );
        const agreement = rows[0];
        if (!agreement) throw errors.notFound({ subject: 'investment_agreement' });
        if (agreement.status !== 'pending_signatures') {
          throw errors.stateTransition('Договор уже подписан или отменён');
        }

        const isInvestor = agreement.investor_id === ctx.userId;
        const isIssuer = agreement.issuer_owner === ctx.userId;
        if (!isInvestor && !isIssuer) throw errors.forbidden({ stage: 'not-a-party' });

        const investorSigned = isInvestor || agreement.investor_signed_at !== null;
        const issuerSigned = isIssuer || agreement.issuer_signed_at !== null;

        await tx.query(
          `UPDATE investments.investment_agreements
              SET investor_signed_at = CASE WHEN $2 THEN COALESCE(investor_signed_at, now())
                                            ELSE investor_signed_at END,
                  issuer_signed_at   = CASE WHEN $3 THEN COALESCE(issuer_signed_at, now())
                                            ELSE issuer_signed_at END
            WHERE id = $1`,
          [agreementId, isInvestor, isIssuer],
        );

        await this.audit.emit(tx, {
          verb: 'investment.agreement.signature_added',
          actorId: ctx.userId,
          actorRole: isInvestor ? 'investor' : 'founder',
          subjectType: 'investment_agreement',
          subjectId: agreementId,
          context: { party: isInvestor ? 'investor' : 'issuer' },
          traceId: ctx.traceId,
        });

        // Переход в `signed` — отдельным шагом и только когда есть обе подписи:
        // договор с одной подписью силы не имеет.
        if (investorSigned && issuerSigned) {
          await tx.query(
            `UPDATE investments.investment_agreements SET status = 'signed' WHERE id = $1`,
            [agreementId],
          );
          await this.audit.record(tx, {
            verb: 'investment.agreement.signed',
            actorId: ctx.userId,
            actorRole: 'system',
            aggregateType: 'investment_agreement',
            aggregateId: agreementId,
            aggregateVersion: 2,
            payload: { agreementId },
            traceId: ctx.traceId,
          });
        }

        return this.readAgreement(tx, agreementId);
      });
    });
  }

  async listAgreements(ctx: RequestContext): Promise<AgreementView[]> {
    await this.assertContourEnabled(ctx);
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<AgreementRow>(
        `${AGREEMENT_SELECT} ORDER BY a.created_at DESC LIMIT 100`,
      );
      return rows.map(mapAgreement);
    });
  }

  /**
   * Подтверждение транша по банковскому событию.
   *
   * Вся логика — в команде БД `billing.confirm_tranche` (5.9.3): она атомарно
   * заводит очередной транш, первым траншем переводит договор в силу и
   * создаёт начисление вознаграждения НА СУММУ ЭТОГО ТРАНША. Повторная
   * доставка того же банковского события возвращает прежний результат вместо
   * дубликата.
   *
   * Сервисный слой сознательно не повторяет эти правила: два источника истины
   * для денег рано или поздно разойдутся.
   */
  async confirmTranche(
    ctx: RequestContext,
    input: {
      agreementId: string;
      bankTransactionRef: string;
      amount: string;
      bookedAt: string;
      statementSha256: string;
    },
  ): Promise<{
    trancheId: string;
    accrualId: string | null;
    trancheNo: number;
    alreadyProcessed: boolean;
  }> {
    return mapInvestmentErrors(async () => {
      await this.assertContourEnabled(ctx);

      // Команда работает от имени сервисной роли: подтверждение транша — не
      // пользовательское действие, а обработка банковского события.
      return this.db.asServiceRole('app_investments', { traceId: ctx.traceId }, async (tx) => {
        const { rows } = await tx.query<{
          tranche_id: string;
          accrual_id: string | null;
          tranche_no: number;
          already_processed: boolean;
        }>(
          `SELECT tranche_id, accrual_id, tranche_no, already_processed
             FROM billing.confirm_tranche($1, $2, $3::numeric, $4::timestamptz, $5, $6, $7)`,
          [
            input.agreementId,
            input.bankTransactionRef,
            input.amount,
            input.bookedAt,
            Buffer.from(input.statementSha256, 'hex'),
            ctx.userId,
            ctx.traceId,
          ],
        );
        const row = rows[0];
        if (!row) throw errors.internal({ reason: 'confirm_tranche returned no row' });
        return {
          trancheId: row.tranche_id,
          accrualId: row.accrual_id,
          trancheNo: Number(row.tranche_no),
          alreadyProcessed: row.already_processed,
        };
      });
    });
  }

  // ------------------------------------------------------------------ private

  /**
   * Контур выключен до гейта A. Проверка идёт первой в каждой операции: любой
   * другой порядок означал бы, что часть работы выполняется до проверки права
   * вообще её выполнять.
   */
  private async assertContourEnabled(ctx: RequestContext): Promise<void> {
    const enabled = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ enabled: boolean }>(
        `SELECT enabled FROM audit.feature_flags WHERE key = 'investments.enabled'`,
      );
      return rows[0]?.enabled ?? false;
    });
    if (!enabled) throw errors.featureDisabled('investments.enabled');
  }

  private async assertInstrumentAllowed(ctx: RequestContext, instrument: string): Promise<void> {
    const flag = INSTRUMENT_FLAGS[instrument];
    if (!flag)
      throw errors.validation([{ path: 'instrumentType', message: 'способ не поддерживается' }]);
    const enabled = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ enabled: boolean }>(
        'SELECT enabled FROM audit.feature_flags WHERE key = $1',
        [flag],
      );
      return rows[0]?.enabled ?? false;
    });
    if (!enabled) throw errors.featureDisabled(flag);
  }

  /** Предложение размещает владелец проекта, и только от проверенного юрлица. */
  private async assertIssuerEligible(
    tx: Tx,
    projectId: string,
    entityId: string,
    userId: string,
  ): Promise<void> {
    const { rows } = await tx.query<{ is_owner: boolean; kyb_ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM lab.founders_projects fp
                       WHERE fp.project_id = $1 AND fp.user_id = $2 AND fp.role = 'owner') AS is_owner,
              kyc.has_valid_kyb($3) AS kyb_ok`,
      [projectId, userId, entityId],
    );
    const row = rows[0];
    if (!row?.is_owner) throw errors.forbidden({ stage: 'not-project-owner' });
    if (!row.kyb_ok) throw errors.kycRequired();
  }

  private async readOffer(tx: Tx, offerId: string): Promise<OfferView> {
    const { rows } = await tx.query<OfferRow>(`${OFFER_SELECT} WHERE o.id = $1`, [offerId]);
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'investment_offer' });
    return mapOffer(row);
  }

  private async readAgreement(tx: Tx, agreementId: string): Promise<AgreementView> {
    const { rows } = await tx.query<AgreementRow>(`${AGREEMENT_SELECT} WHERE a.id = $1`, [
      agreementId,
    ]);
    const row = rows[0];
    if (!row) throw errors.notFound({ subject: 'investment_agreement' });
    return mapAgreement(row);
  }
}

// ------------------------------------------------------------------ проекции

const OFFER_SELECT = `
  SELECT o.id, o.project_id, o.issuer_entity_id, o.instrument_type, o.rules_version,
         o.target_amount::text AS target_amount, o.min_investment::text AS min_investment,
         o.currency, o.status, o.opens_at, o.closes_at, o.created_at,
         COALESCE((SELECT sum(a.contract_amount) FROM investments.investment_agreements a
                    WHERE a.offer_id = o.id AND a.status <> 'cancelled'), 0)::text AS taken_amount
    FROM investments.investment_offers o
`;

const AGREEMENT_SELECT = `
  SELECT a.id, a.offer_id, a.investor_id, a.contract_amount::text AS contract_amount,
         a.currency, a.status, a.investor_signed_at, a.issuer_signed_at,
         a.effective_at, a.created_at
    FROM investments.investment_agreements a
`;

interface OfferRow {
  id: string;
  project_id: string;
  issuer_entity_id: string;
  instrument_type: string;
  rules_version: string;
  target_amount: string;
  min_investment: string;
  currency: string;
  status: string;
  opens_at: Date | null;
  closes_at: Date | null;
  created_at: Date;
  taken_amount: string;
}

export interface OfferView {
  id: string;
  projectId: string;
  issuerEntityId: string;
  instrumentType: string;
  rulesVersion: string;
  targetAmount: string;
  takenAmount: string;
  minInvestment: string;
  currency: string;
  status: string;
  opensAt: string | null;
  closesAt: string | null;
  createdAt: string;
}

function mapOffer(row: OfferRow): OfferView {
  return {
    id: row.id,
    projectId: row.project_id,
    issuerEntityId: row.issuer_entity_id,
    instrumentType: row.instrument_type,
    rulesVersion: row.rules_version,
    targetAmount: row.target_amount,
    takenAmount: row.taken_amount,
    minInvestment: row.min_investment,
    currency: row.currency,
    status: row.status,
    opensAt: row.opens_at?.toISOString() ?? null,
    closesAt: row.closes_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

interface AgreementRow {
  id: string;
  offer_id: string;
  investor_id: string;
  contract_amount: string;
  currency: string;
  status: string;
  investor_signed_at: Date | null;
  issuer_signed_at: Date | null;
  effective_at: Date | null;
  created_at: Date;
}

export interface AgreementView {
  id: string;
  offerId: string;
  investorId: string;
  contractAmount: string;
  currency: string;
  status: string;
  investorSignedAt: string | null;
  issuerSignedAt: string | null;
  effectiveAt: string | null;
  createdAt: string;
}

function mapAgreement(row: AgreementRow): AgreementView {
  return {
    id: row.id,
    offerId: row.offer_id,
    investorId: row.investor_id,
    contractAmount: row.contract_amount,
    currency: row.currency,
    status: row.status,
    investorSignedAt: row.investor_signed_at?.toISOString() ?? null,
    issuerSignedAt: row.issuer_signed_at?.toISOString() ?? null,
    effectiveAt: row.effective_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Текст условий предложения.
 *
 * Формат намеренно простой и детерминированный: по нему считается sha256,
 * который хранится в базе, поэтому любое изменение представления меняет
 * отпечаток уже подписанных документов. Богатая вёрстка появится вместе с
 * генератором PDF, но отпечаток должен браться от того, что подписано.
 */
function renderOfferDocument(input: {
  offerId: string;
  projectId: string;
  issuerEntityId: string;
  instrumentType: string;
  targetAmount: string;
  minInvestment: string;
  terms: Record<string, unknown>;
}): Buffer {
  const lines = [
    'ИНВЕСТИЦИОННОЕ ПРЕДЛОЖЕНИЕ',
    `Идентификатор: ${input.offerId}`,
    `Проект: ${input.projectId}`,
    `Лицо, привлекающее инвестиции: ${input.issuerEntityId}`,
    `Способ инвестирования: ${input.instrumentType}`,
    `Целевая сумма: ${input.targetAmount} RUB`,
    `Минимальная инвестиция: ${input.minInvestment} RUB`,
    `Условия: ${JSON.stringify(input.terms)}`,
    '',
    'Оператор инвестиционной платформы не является стороной договора',
    'инвестирования. Вознаграждение оператора начисляется однократно после',
    'подписания договора обеими сторонами и подтверждения первого транша.',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

function renderAgreementDocument(input: {
  agreementId: string;
  offerId: string;
  investorId: string;
  amount: string;
}): Buffer {
  const lines = [
    'ДОГОВОР ИНВЕСТИРОВАНИЯ',
    `Идентификатор: ${input.agreementId}`,
    `Инвестиционное предложение: ${input.offerId}`,
    `Инвестор: ${input.investorId}`,
    `Сумма договора: ${input.amount} RUB`,
    '',
    'Договор вступает в силу после подписания обеими сторонами и подтверждения',
    'перечисления первого транша через номинальный счёт оператора. База',
    'вознаграждения оператора — полная сумма договора; последующие транши',
    'нового начисления не создают.',
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

/**
 * Инварианты регулируемого контура живут в триггерах БД. Здесь они переводятся
 * в доменные ошибки: иначе наружу ушла бы 500 с текстом PostgreSQL, а клиент
 * не смог бы отличить «превышен лимит» от «сервер сломался».
 */
export async function mapInvestmentErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const pg = error as { code?: string; message?: string };
    const message = pg.message ?? '';

    if (message.includes('is not published')) {
      throw errors.stateTransition('Предложение не опубликовано');
    }
    if (message.includes('exceeds offer target') || message.includes('capacity')) {
      throw errors.limitExceeded('Сумма превышает остаток по предложению');
    }
    if (message.includes('below min_investment') || message.includes('min_investment')) {
      throw errors.validation([{ path: 'amount', message: 'сумма меньше минимальной' }]);
    }
    if (message.includes('self-deal') || message.includes('beneficiary')) {
      throw errors.selfDeal();
    }
    // Триггеры регулируемого контура поднимают «проверка не пройдена» с кодом
    // 42501 — тем же, что и реальный отказ политики. Различает их только текст,
    // поэтому KYC и KYB разбираются до общей ветки 42501: иначе непройденная
    // проверка юрлица выглядела бы как поломка прав доступа.
    if (/\bKY[CB]\b/.test(message)) {
      throw errors.kycRequired();
    }
    if (message.includes('illegal agreement transition')) {
      throw errors.stateTransition('Недопустимый переход статуса договора');
    }
    if (pg.code === '23505') {
      throw errors.conflict('Операция уже выполнена', { reason: 'duplicate' });
    }
    if (pg.code === '42501') {
      throw errors.forbidden({ stage: 'db-policy' });
    }
    throw error;
  }
}
