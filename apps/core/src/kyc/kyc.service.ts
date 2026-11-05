import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type AddEntityMemberRequest,
  type BusinessEntity,
  type CreateEntityRequest,
  type EntityMember,
  type KybVerification,
  type KycDecisionRequest,
  type KycVerification,
  type StartKycRequest,
} from '@fifth/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { encodeIntegrationCursor } from '../common/keyset-cursor';

/**
 * KYC физлиц и KYB юрлиц.
 *
 * Три инварианта, которые здесь важнее удобства:
 *
 *  1. Документы и идентификаторы шифруются и наружу не возвращаются никогда —
 *     ни владельцу, ни комплаенсу через этот API. Наружу уходит статус и
 *     маска; сами данные живут в зашифрованном виде и в S3.
 *  2. Статус меняет только комплаенс. Пользователь создаёт заявку, но не может
 *     перевести её в `approved` — это закрыто и политикой RLS, и триггером.
 *  3. Самоодобрение запрещено. Проверяющий не может решать по собственной
 *     заявке и по юрлицу, с которым связан (миграция M013).
 */

/** Срок действия одобренной проверки по умолчанию: год. */
const DEFAULT_VALIDITY_DAYS = 365;
/** За сколько дней до истечения проверка попадает в очередь пересмотра. */
const REVIEW_LEAD_DAYS = 30;

/**
 * Нарушение уникальности ИМЕННО по ИНН и юрисдикции.
 *
 * Имя ограничения проверяется явно: под код `23505` попадают и другие
 * уникальные индексы, и переводить их все в «юрлицо уже заведено» значило бы
 * прятать чужие дефекты за понятным текстом.
 */
function isEntityUniqueViolation(error: unknown): boolean {
  const pg = error as { code?: string; constraint?: string };
  return pg?.code === '23505' && pg.constraint === 'business_entities_inn_uq';
}

@Injectable()
export class KycService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
  ) {}

  // --------------------------------------------------------------- KYC физлиц

  async startVerification(ctx: RequestContext, input: StartKycRequest): Promise<KycVerification> {
    return this.db.transaction(ctx, async (tx) => {
      // Повторная подача при уже действующей проверке — не ошибка клиента, а
      // бессмысленная работа для комплаенса. Возвращаем существующую.
      const existing = await tx.query<VerificationRow>(
        `SELECT id, kind, status, rejection_reason, expires_at, created_at
           FROM kyc.kyc_verifications
          WHERE user_id = $1 AND kind = $2
            AND (status IN ('pending','in_review','verification_pending')
                 OR (status = 'approved' AND (expires_at IS NULL OR expires_at > now())))
          ORDER BY created_at DESC
          LIMIT 1`,
        [ctx.userId, input.kind],
      );
      const found = existing.rows[0];
      if (found) return mapVerification(found);

      const id = uuidv7();
      const { rows } = await tx.query<VerificationRow>(
        `INSERT INTO kyc.kyc_verifications
           (id, user_id, kind, status, provider, doc_type, doc_country)
         VALUES ($1, $2, $3, 'pending', 'manual', $4, $5)
         RETURNING id, kind, status, rejection_reason, expires_at, created_at`,
        [id, ctx.userId, input.kind, input.docType, input.docCountry],
      );

      await this.audit.emit(tx, {
        verb: 'kyc.verification.submitted',
        actorId: ctx.userId,
        actorRole: primaryRole(ctx),
        subjectType: 'kyc_verification',
        subjectId: id,
        // В контекст события идёт вид проверки, но не документ и не страна
        // выдачи: журнал читают шире, чем комплаенс.
        context: { kind: input.kind },
        traceId: ctx.traceId,
      });

      return mapVerification(rows[0]!);
    });
  }

  async listVerifications(ctx: RequestContext): Promise<KycVerification[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<VerificationRow>(
        `SELECT id, kind, status, rejection_reason, expires_at, created_at
           FROM kyc.kyc_verifications
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [ctx.userId],
      );
      return rows.map(mapVerification);
    });
  }

  // --------------------------------------------------------------- юрлица

  async createEntity(ctx: RequestContext, input: CreateEntityRequest): Promise<BusinessEntity> {
    const innIndex = await this.crypto.blindIndex(input.inn, 'inn');
    const sealed = await this.crypto.sealMany('kyb_documents', {
      inn: input.inn,
      ogrn: input.ogrn,
    });
    const id = uuidv7();

    try {
      return await this.insertEntity(ctx, input, id, innIndex, sealed);
    } catch (error) {
      // Юрлицо, заведённое ДРУГИМ пользователем, текущему не видно из-за RLS,
      // поэтому предварительная проверка его не найдёт — дубликат ловится
      // уникальным индексом. Ответ одинаков в обоих случаях: подтверждать, что
      // конкретный ИНН уже заведён кем-то, значит выдавать чужие данные.
      if ((error as { code?: string }).code === '23505') {
        throw errors.conflict('Юридическое лицо с такими данными уже заведено', {
          reason: 'entity-exists-unique',
        });
      }
      throw error;
    }
  }

  private async insertEntity(
    ctx: RequestContext,
    input: CreateEntityRequest,
    id: string,
    innIndex: Buffer,
    sealed: { ciphertexts: { inn: Buffer | null; ogrn: Buffer | null }; wrappedDek: Buffer },
  ): Promise<BusinessEntity> {
    return this.db.transaction(ctx, async (tx) => {
      const duplicate = await tx.query(
        `SELECT 1 FROM kyc.business_entities
          WHERE inn_hmac = $1 AND jurisdiction = $2 AND deleted_at IS NULL LIMIT 1`,
        [innIndex, input.jurisdiction],
      );
      if (duplicate.rows.length > 0) {
        // Формулировка не подтверждает, кому принадлежит юрлицо: это была бы
        // справка о чужом бизнесе по ИНН.
        throw errors.conflict('Юридическое лицо с такими данными уже заведено', {
          reason: 'entity-exists',
        });
      }

      let rows: EntityRow[];
      try {
        const inserted = await tx.query<EntityRow>(
          `INSERT INTO kyc.business_entities
             (id, legal_name, legal_form, inn_ciphertext, ogrn_ciphertext, entity_wrapped_dek,
              inn_hmac, jurisdiction, owner_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, legal_name, legal_form, inn_ciphertext, entity_wrapped_dek,
                     jurisdiction, registry_status, created_at`,
          [
            id,
            input.legalName,
            input.legalForm ?? null,
            sealed.ciphertexts.inn,
            sealed.ciphertexts.ogrn,
            sealed.wrappedDek,
            innIndex,
            input.jurisdiction,
            ctx.userId,
          ],
        );
        rows = inserted.rows;
      } catch (error) {
        // Проверка дубликата выше и вставка — разные моменты времени. Дубликат
        // не возникает (UNIQUE-индекс по инн+юрисдикции), но без этого перевода
        // наружу уходила бы «внутренняя ошибка» вместо доменного отказа — тот
        // же дефект, что был найден в гонке регистрации.
        //
        // Текст отказа ТОТ ЖЕ, что у предпроверки: иначе гонка отличалась бы
        // от обычного дубликата и давала справку о чужом ИНН.
        if (isEntityUniqueViolation(error)) {
          throw errors.conflict('Юридическое лицо с такими данными уже заведено', {
            reason: 'entity-exists-race',
          });
        }
        throw error;
      }

      // Владелец сразу становится подписантом: без этого он не сможет подать
      // юрлицо на проверку — политика kyb_insert требует роли signatory.
      await tx.query(
        `INSERT INTO kyc.entity_members (entity_id, user_id, member_role)
         VALUES ($1, $2, 'signatory')
         ON CONFLICT DO NOTHING`,
        [id, ctx.userId],
      );

      await this.audit.emit(tx, {
        verb: 'kyc.entity.created',
        actorId: ctx.userId,
        actorRole: primaryRole(ctx),
        subjectType: 'business_entity',
        subjectId: id,
        context: { jurisdiction: input.jurisdiction },
        traceId: ctx.traceId,
      });

      // ИНН только что введён: маска считается из него, без лишнего обращения к службе ключей.
      return this.toEntity(rows[0]!, false, maskInn(input.inn));
    });
  }

  async listEntities(ctx: RequestContext): Promise<BusinessEntity[]> {
    const rows = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<EntityRow & { kyb_approved: boolean }>(
        `SELECT e.id, e.legal_name, e.legal_form, e.inn_ciphertext, e.entity_wrapped_dek,
                e.jurisdiction, e.registry_status, e.created_at,
                kyc.has_valid_kyb(e.id) AS kyb_approved
           FROM kyc.business_entities e
          WHERE e.deleted_at IS NULL
          ORDER BY e.created_at DESC
          LIMIT 50`,
      );
      return rows;
    });
    return Promise.all(rows.map((row) => this.mapEntity(row, row.kyb_approved)));
  }

  async addMember(
    ctx: RequestContext,
    entityId: string,
    input: AddEntityMemberRequest,
  ): Promise<EntityMember> {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertEntityVisible(tx, entityId);

      // Без RETURNING намеренно: политика чтения состава отдаёт пользователю
      // только его собственные строки, поэтому возврат ЧУЖОЙ добавленной строки
      // упёрся бы в RLS. Ответ собирается из проверенного входа.
      await tx.query(
        `INSERT INTO kyc.entity_members (entity_id, user_id, member_role, share_pct)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (entity_id, user_id, member_role)
         DO UPDATE SET share_pct = EXCLUDED.share_pct`,
        [entityId, input.userId, input.memberRole, input.sharePct ?? null],
      );

      await this.audit.emit(tx, {
        verb: 'kyc.entity.member_added',
        actorId: ctx.userId,
        actorRole: primaryRole(ctx),
        subjectType: 'business_entity',
        subjectId: entityId,
        context: { memberRole: input.memberRole },
        traceId: ctx.traceId,
      });

      return {
        entityId,
        userId: input.userId,
        memberRole: input.memberRole,
        sharePct: input.sharePct ?? null,
        verifiedAt: null,
      };
    });
  }

  async startKyb(
    ctx: RequestContext,
    entityId: string,
    kind: 'registry_check' | 'beneficial_owners' | 'accreditation' | 'annual_review',
  ): Promise<KybVerification> {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertEntityVisible(tx, entityId);

      const existing = await tx.query<KybRow>(
        `SELECT id, entity_id, kind, status, rejection_reason, expires_at, created_at
           FROM kyc.kyb_verifications
          WHERE entity_id = $1 AND kind = $2
            AND (status IN ('pending','in_review','verification_pending')
                 OR (status = 'approved' AND (expires_at IS NULL OR expires_at > now())))
          ORDER BY created_at DESC LIMIT 1`,
        [entityId, kind],
      );
      const found = existing.rows[0];
      if (found) return mapKyb(found);

      const id = uuidv7();
      const { rows } = await tx.query<KybRow>(
        `INSERT INTO kyc.kyb_verifications (id, entity_id, kind, status, provider)
         VALUES ($1, $2, $3, 'pending', 'manual')
         RETURNING id, entity_id, kind, status, rejection_reason, expires_at, created_at`,
        [id, entityId, kind],
      );

      await this.audit.emit(tx, {
        verb: 'kyc.kyb.submitted',
        actorId: ctx.userId,
        actorRole: primaryRole(ctx),
        subjectType: 'kyb_verification',
        subjectId: id,
        context: { kind },
        traceId: ctx.traceId,
      });

      return mapKyb(rows[0]!);
    });
  }

  // ------------------------------------------------------------- комплаенс

  /**
   * Очередь верификаций. Доступна только роли admin (проверяется маршрутом).
   *
   * Постраничная выборка по курсору, а не просто `LIMIT`. Раньше очередь
   * отдавала 50 самых старых заявок и способа дойти до остальных не было
   * вовсе: при 52 ожидающих последние две не видел никто, и «пусто» на экране
   * означало «дальше не показываем», а не «заявок нет». Поймано прогоном
   * `smoke-lab` на накопленных данных.
   *
   * Курсор keyset по паре «момент + идентификатор»: пара уникальна, поэтому
   * страницы не перекрываются и не теряют строк даже при одинаковом
   * `created_at`. Формат — тот же, что у Integration API: второй формат курсора
   * в проекте рано или поздно разойдётся с первым.
   */
  async reviewQueue(
    ctx: RequestContext,
    limit: number,
    cursor?: { at: string; id: string },
  ): Promise<{ items: KycVerification[]; nextCursor: string | null }> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<VerificationRow>(
        // Имя заявителя джойном: без него оператор одобряет строку
        // идентификатора, а не человека.
        `SELECT v.id, v.kind, v.status, v.rejection_reason, v.expires_at, v.created_at,
                u.display_name AS subject_name
           FROM kyc.kyc_verifications v
           LEFT JOIN identity.users u ON u.id = v.user_id
          WHERE v.status IN ('pending','in_review')
            AND ($2::timestamptz IS NULL OR (v.created_at, v.id) > ($2::timestamptz, $3::uuid))
          ORDER BY v.created_at, v.id
          LIMIT $1`,
        [limit + 1, cursor?.at ?? null, cursor?.id ?? null],
      );
      // Берётся на одну строку больше предела: наличие «лишней» и есть признак
      // того, что следующая страница существует. Считать общее число незачем —
      // это отдельный дорогой запрос ради одного признака.
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(mapVerification),
        nextCursor:
          hasMore && last
            ? encodeIntegrationCursor({ at: last.created_at.toISOString(), id: last.id })
            : null,
      };
    });
  }

  async decide(
    ctx: RequestContext,
    verificationId: string,
    input: KycDecisionRequest,
  ): Promise<KycVerification> {
    return this.db.transaction(ctx, async (tx) => {
      const target = await tx.query<{ user_id: string; status: string }>(
        // FOR UPDATE: два параллельных решения читали статус без блокировки и
        // оба проходили — «последний победил», в журнале два решения по одной
        // заявке. Рядом, в 4-eyes цены, эта же гонка была закрыта раньше;
        // здесь она оставалась (MEDIUM внешнего аудита №2).
        'SELECT user_id, status FROM kyc.kyc_verifications WHERE id = $1 FOR UPDATE',
        [verificationId],
      );
      const row = target.rows[0];
      if (!row) throw errors.notFound({ subject: 'kyc_verification' });
      if (row.user_id === ctx.userId) {
        // Дублирует триггер M013. Сервис отвечает понятной ошибкой вместо
        // исключения драйвера, но защита существует независимо от него.
        throw errors.forbidden({ stage: 'self-review' });
      }
      if (row.status === 'approved' || row.status === 'rejected') {
        throw errors.stateTransition('Решение по этой верификации уже принято');
      }

      const expiresAt =
        input.decision === 'approved'
          ? (input.expiresAt ?? isoInDays(DEFAULT_VALIDITY_DAYS))
          : null;
      const nextReviewAt =
        expiresAt === null
          ? null
          : new Date(new Date(expiresAt).getTime() - REVIEW_LEAD_DAYS * 86_400_000).toISOString();

      const updated = await tx.query<VerificationRow>(
        `UPDATE kyc.kyc_verifications
            SET status = $2,
                rejection_reason = $3,
                risk_level = COALESCE($4, risk_level),
                reviewed_by = $5,
                decided_at = now(),
                expires_at = $6::timestamptz,
                next_review_at = $7::timestamptz
          WHERE id = $1
          RETURNING id, kind, status, rejection_reason, expires_at, created_at`,
        [
          verificationId,
          input.decision,
          input.decision === 'rejected' ? (input.reason ?? 'не указана') : null,
          input.riskLevel ?? null,
          ctx.userId,
          expiresAt,
          nextReviewAt,
        ],
      );

      await this.audit.emit(tx, {
        verb: 'kyc.verification.decided',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'kyc_verification',
        subjectId: verificationId,
        context: { decision: input.decision, riskLevel: input.riskLevel ?? null },
        traceId: ctx.traceId,
      });

      return mapVerification(updated.rows[0]!);
    });
  }

  async decideKyb(
    ctx: RequestContext,
    kybId: string,
    input: KycDecisionRequest,
  ): Promise<KybVerification> {
    return this.db.transaction(ctx, async (tx) => {
      const target = await tx.query<{ entity_id: string; status: string }>(
        // FOR UPDATE — как и в decide по верификации личности (аудит №2).
        'SELECT entity_id, status FROM kyc.kyb_verifications WHERE id = $1 FOR UPDATE',
        [kybId],
      );
      const row = target.rows[0];
      if (!row) throw errors.notFound({ subject: 'kyb_verification' });
      if (row.status === 'approved' || row.status === 'rejected') {
        throw errors.stateTransition('Решение по этой проверке уже принято');
      }

      const expiresAt =
        input.decision === 'approved'
          ? (input.expiresAt ?? isoInDays(DEFAULT_VALIDITY_DAYS))
          : null;

      const updated = await tx.query<KybRow>(
        `UPDATE kyc.kyb_verifications
            SET status = $2,
                rejection_reason = $3,
                reviewed_by = $4,
                decided_at = now(),
                expires_at = $5::timestamptz
          WHERE id = $1
          RETURNING id, entity_id, kind, status, rejection_reason, expires_at, created_at`,
        [
          kybId,
          input.decision,
          input.decision === 'rejected' ? (input.reason ?? 'не указана') : null,
          ctx.userId,
          expiresAt,
        ],
      );

      // Проверка реестра — единственный вид, который делает юрлицо «живым» для
      // инвестконтура; отражаем это и в самой записи о юрлице.
      if (input.decision === 'approved') {
        await tx.query(
          `UPDATE kyc.business_entities
              SET registry_status = 'active', registry_checked_at = now(), updated_at = now()
            WHERE id = $1 AND registry_status = 'unknown'`,
          [row.entity_id],
        );
      }

      await this.audit.emit(tx, {
        verb: 'kyc.kyb.decided',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'kyb_verification',
        subjectId: kybId,
        context: { decision: input.decision },
        traceId: ctx.traceId,
      });

      return mapKyb(updated.rows[0]!);
    });
  }

  // ------------------------------------------------------------------ private

  /**
   * Юрлицо должно быть видимо текущему пользователю по RLS. Отсутствие строки
   * и отсутствие прав дают ОДИН ответ: иначе перебор идентификаторов сообщал бы
   * о существовании чужих юрлиц.
   */
  private async assertEntityVisible(tx: Tx, entityId: string): Promise<void> {
    const { rows } = await tx.query(
      'SELECT 1 FROM kyc.business_entities WHERE id = $1 AND deleted_at IS NULL',
      [entityId],
    );
    if (rows.length === 0) throw errors.notFound({ subject: 'business_entity' });
  }

  private async mapEntity(row: EntityRow, kybApproved: boolean): Promise<BusinessEntity> {
    let innMasked = '***';
    if (row.entity_wrapped_dek && row.inn_ciphertext) {
      const inn = await this.crypto.openField(
        'kyb_documents',
        row.entity_wrapped_dek,
        row.inn_ciphertext,
        'inn',
      );
      innMasked = maskInn(inn.toString('utf8'));
    }
    return this.toEntity(row, kybApproved, innMasked);
  }

  private toEntity(row: EntityRow, kybApproved: boolean, innMasked: string): BusinessEntity {
    return {
      id: row.id,
      legalName: row.legal_name,
      legalForm: row.legal_form,
      innMasked,
      jurisdiction: row.jurisdiction,
      registryStatus: row.registry_status,
      kybApproved,
      createdAt: row.created_at.toISOString(),
    };
  }
}

function maskInn(inn: string): string {
  return `${'*'.repeat(Math.max(0, inn.length - 4))}${inn.slice(-4)}`;
}

// ------------------------------------------------------------------- строки БД

interface VerificationRow {
  id: string;
  kind: string;
  status: KycVerification['status'];
  rejection_reason: string | null;
  expires_at: Date | null;
  created_at: Date;
  /** Имя заявителя. Заполняется только в очереди комплаенса. */
  subject_name?: string | null;
}

interface KybRow extends VerificationRow {
  entity_id: string;
}

interface EntityRow {
  id: string;
  legal_name: string;
  legal_form: string | null;
  inn_ciphertext: Buffer | null;
  entity_wrapped_dek: Buffer | null;
  jurisdiction: string;
  registry_status: BusinessEntity['registryStatus'];
  created_at: Date;
}

/**
 * Причина отказа наружу отдаётся обобщённо. Внутренняя формулировка комплаенса
 * («паспорт не читается, подозрение на монтаж») — материал для расследования,
 * а не для показа пользователю.
 */
function mapVerification(row: VerificationRow): KycVerification {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    rejectionSummary: row.rejection_reason === null ? null : 'Проверка не пройдена',
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    // Только там, где запрос его выбрал: в собственных проверках пользователя
    // имя заявителя — это он сам, и повторять его незачем.
    ...(row.subject_name === undefined ? {} : { subjectName: row.subject_name }),
  };
}

function mapKyb(row: KybRow): KybVerification {
  return {
    id: row.id,
    entityId: row.entity_id,
    kind: row.kind,
    status: row.status,
    rejectionSummary: row.rejection_reason === null ? null : 'Проверка не пройдена',
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function isoInDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Роль актора для журнала: реестр событий проверяет её по allowlist. */
function primaryRole(ctx: RequestContext): string {
  return ctx.roles[0] ?? 'system';
}
