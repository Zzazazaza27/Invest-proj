import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type AddProductLink,
  type CreateProjectRequest,
  type ProjectFull,
  type ProjectMaterial,
  type ProjectSummary,
  type ProjectVersion,
  type RequestUpload,
  type UpdateProjectRequest,
  type UploadTicket,
} from '@unicorn/contracts';
import { AppError, errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { S3Service } from '../storage/s3.service';

/**
 * Проекты и листинги основателя.
 *
 * Главное правило фазы: **тариф резолвит сервер**, а не клиент. `investment_ask`
 * — единственный вход, из которого берётся `required_plan_id`
 * (Architect_Launch §5.1). Клиент не может ни выбрать план, ни удержать старый
 * после роста запроса: пересчёт происходит при каждом изменении суммы, а
 * публикация с несоответствующим планом отвергается триггером БД.
 *
 * Второе правило: публикация листинга — не смена флага, а прохождение условий.
 * Их три, и все проверяются до записи: действующий KYC владельца, тариф,
 * соответствующий текущему запросу, и активная подписка этого тарифа.
 */

/** Лимиты загрузки по типу материала. Больше — отказ на стороне хранилища. */
const MAX_UPLOAD_BYTES: Record<'deck' | 'video' | 'doc', number> = {
  deck: 50 * 1024 * 1024,
  video: 500 * 1024 * 1024,
  doc: 25 * 1024 * 1024,
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly s3: S3Service,
  ) {}

  async create(ctx: RequestContext, input: CreateProjectRequest): Promise<ProjectFull> {
    const id = uuidv7();
    return this.db.transaction(ctx, async (tx) => {
      const planId = await resolveFounderPlan(tx, input.investmentAsk);

      // RETURNING здесь недопустим, и это не стилистика: возврат строки требует
      // прав на SELECT, а видимость проекта даёт запись в founders_projects,
      // которой в этот момент ещё нет. INSERT ... RETURNING упал бы на RLS —
      // причём с сообщением про нарушение политики вставки, уводящим в сторону.
      await tx.query(
        `INSERT INTO lab.projects
           (id, taxonomy_id, title, tagline, description, stage, geo_country, geo_region,
            investment_ask, ask_currency, required_plan_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, $11)`,
        [
          id,
          input.taxonomyId,
          input.title,
          input.tagline ?? null,
          input.description ?? null,
          input.stage,
          input.geoCountry ?? null,
          input.geoRegion ?? null,
          input.investmentAsk,
          input.askCurrency,
          planId,
        ],
      );

      await tx.query(
        `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [id, ctx.userId],
      );

      await this.audit.emit(tx, {
        verb: 'lab.project.created',
        actorId: ctx.userId,
        actorRole: 'founder',
        subjectType: 'project',
        subjectId: id,
        context: { investmentAsk: input.investmentAsk, stage: input.stage },
        traceId: ctx.traceId,
      });

      // Теперь владелец записан, и та же транзакция уже видит проект.
      return this.reread(tx, id);
    });
  }

  /** Проекты, к которым пользователь причастен. RLS отдаёт только свои. */
  async listMine(ctx: RequestContext): Promise<ProjectSummary[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<ProjectSummaryRow>(
        `SELECT p.id, p.title, p.stage, p.status, p.listing_status,
                p.investment_ask::text AS investment_ask, p.ask_currency,
                p.required_plan_id, sp.code AS required_plan_code,
                fp.role, p.created_at
           FROM lab.founders_projects fp
           JOIN lab.projects p ON p.id = fp.project_id
           LEFT JOIN billing.subscription_plans sp ON sp.id = p.required_plan_id
          WHERE fp.user_id = $1 AND p.deleted_at IS NULL
          ORDER BY p.created_at DESC
          LIMIT 100`,
        [ctx.userId],
      );
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        stage: row.stage,
        status: row.status,
        listingStatus: row.listing_status,
        investmentAsk: row.investment_ask,
        askCurrency: row.ask_currency as 'RUB',
        requiredPlanId: row.required_plan_id,
        requiredPlanCode: row.required_plan_code,
        role: row.role,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async getOne(ctx: RequestContext, projectId: string): Promise<ProjectFull> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const row = rows[0];
      // RLS уже отфильтровала чужое; отсутствие строки и отсутствие прав дают
      // один и тот же ответ намеренно.
      if (!row) throw errors.notFound({ subject: 'project' });
      return mapProject(row);
    });
  }

  async update(
    ctx: RequestContext,
    projectId: string,
    input: UpdateProjectRequest,
  ): Promise<ProjectFull> {
    if (Object.keys(input).length === 0) {
      throw errors.validation([{ path: '(корень)', message: 'нет полей для изменения' }]);
    }

    return this.runMapped(async () =>
      this.db.transaction(ctx, async (tx) => {
        const current = await tx.query<{ investment_ask: string; listing_status: string }>(
          `SELECT investment_ask::text AS investment_ask, listing_status
             FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
          [projectId],
        );
        const existing = current.rows[0];
        if (!existing) throw errors.notFound({ subject: 'project' });

        // Пересчёт тарифа обязателен при любом изменении запроса инвестиций:
        // без него проект остался бы в каталоге на тарифе, который его больше
        // не покрывает.
        const nextAsk = input.investmentAsk ?? existing.investment_ask;
        const planId =
          input.investmentAsk === undefined ? null : await resolveFounderPlan(tx, nextAsk);

        const { rows } = await tx.query<ProjectRow>(
          `UPDATE lab.projects
              SET title            = COALESCE($2, title),
                  tagline          = COALESCE($3, tagline),
                  description      = COALESCE($4, description),
                  stage            = COALESCE($5, stage),
                  taxonomy_id      = COALESCE($6, taxonomy_id),
                  geo_country      = COALESCE($7, geo_country),
                  geo_region       = COALESCE($8, geo_region),
                  investment_ask   = COALESCE($9::numeric, investment_ask),
                  required_plan_id = COALESCE($10, required_plan_id),
                  updated_at       = now()
            WHERE id = $1 AND deleted_at IS NULL
            RETURNING ${PROJECT_COLUMNS}`,
          [
            projectId,
            input.title ?? null,
            input.tagline ?? null,
            input.description ?? null,
            input.stage ?? null,
            input.taxonomyId ?? null,
            input.geoCountry ?? null,
            input.geoRegion ?? null,
            input.investmentAsk ?? null,
            planId,
          ],
        );
        const row = rows[0];
        if (!row) throw errors.notFound({ subject: 'project' });

        await this.audit.emit(tx, {
          verb: 'lab.project.updated',
          actorId: ctx.userId,
          actorRole: 'founder',
          subjectType: 'project',
          subjectId: projectId,
          context: { fields: Object.keys(input) },
          traceId: ctx.traceId,
        });

        return mapProject(row);
      }),
    );
  }

  /**
   * Подача заявки в сезон.
   *
   * Создаёт НЕИЗМЕНЯЕМЫЙ снимок карточки: на него потом ссылаются AI-скоринг и
   * рецензии экспертов. Если бы заявку можно было переписать после подачи,
   * оценка относилась бы к тексту, которого больше не существует.
   */
  async submit(ctx: RequestContext, projectId: string): Promise<ProjectVersion> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: projectRows } = await tx.query<ProjectRow>(
        `SELECT ${PROJECT_COLUMNS} FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const project = projectRows[0];
      if (!project) throw errors.notFound({ subject: 'project' });
      if (project.status !== 'draft' && project.status !== 'submitted') {
        throw errors.stateTransition('Проект уже в работе: подача новой версии недоступна');
      }

      const season = await tx.query<{ id: string }>(
        `SELECT id FROM seasons.seasons
          WHERE status = 'applications_open'
          ORDER BY number DESC LIMIT 1`,
      );
      const seasonId = season.rows[0]?.id;
      if (!seasonId) {
        throw errors.stateTransition('Приём заявок в сезон сейчас закрыт');
      }

      const next = await tx.query<{ next_no: string }>(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
           FROM lab.project_versions WHERE project_id = $1 AND season_id = $2`,
        [projectId, seasonId],
      );
      const versionNo = Number(next.rows[0]?.next_no ?? 1);

      const versionId = uuidv7();
      const snapshot = {
        title: project.title,
        tagline: project.tagline,
        description: project.description,
        stage: project.stage,
        taxonomyId: project.taxonomy_id,
        geoCountry: project.geo_country,
        geoRegion: project.geo_region,
        investmentAsk: project.investment_ask,
        askCurrency: project.ask_currency,
      };

      const { rows } = await tx.query<VersionRow>(
        `INSERT INTO lab.project_versions (id, project_id, season_id, version_no, snapshot_jsonb)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, project_id, season_id, version_no, submitted_at`,
        [versionId, projectId, seasonId, versionNo, JSON.stringify(snapshot)],
      );

      await tx.query(
        `UPDATE lab.projects
            SET current_version_id = $2, season_id = $3,
                status = 'submitted', updated_at = now()
          WHERE id = $1`,
        [projectId, versionId, seasonId],
      );

      await this.audit.record(tx, {
        verb: 'lab.project.submitted',
        actorId: ctx.userId,
        actorRole: 'founder',
        aggregateType: 'project',
        aggregateId: projectId,
        aggregateVersion: versionNo,
        payload: { projectId, seasonId, versionNo },
        traceId: ctx.traceId,
      });

      const row = rows[0]!;
      return {
        id: row.id,
        projectId: row.project_id,
        seasonId: row.season_id,
        versionNo: row.version_no,
        submittedAt: row.submitted_at.toISOString(),
      };
    });
  }

  // ------------------------------------------------------------------ материалы

  async listMaterials(ctx: RequestContext, projectId: string): Promise<ProjectMaterial[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<MaterialRow>(
        `SELECT id, project_id, type, version, url, parse_status, created_at
           FROM lab.project_materials
          WHERE project_id = $1
          ORDER BY created_at DESC
          LIMIT 100`,
        [projectId],
      );
      return rows.map(mapMaterial);
    });
  }

  async addProductLink(ctx: RequestContext, input: AddProductLink): Promise<ProjectMaterial> {
    return this.runMapped(async () =>
      this.db.transaction(ctx, async (tx) => {
        await this.assertProjectVisible(tx, input.projectId);
        const version = await this.nextMaterialVersion(tx, input.projectId, 'product_link');
        const id = uuidv7();

        const { rows } = await tx.query<MaterialRow>(
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, url, parse_status, uploaded_by)
           VALUES ($1, $2, 'product_link', $3, $4, 'not_required', $5)
           RETURNING id, project_id, type, version, url, parse_status, created_at`,
          [id, input.projectId, version, input.url, ctx.userId],
        );

        await this.audit.emit(tx, {
          verb: 'lab.material.added',
          actorId: ctx.userId,
          actorRole: 'founder',
          subjectType: 'project',
          subjectId: input.projectId,
          context: { type: 'product_link' },
          traceId: ctx.traceId,
        });

        return mapMaterial(rows[0]!);
      }),
    );
  }

  /**
   * Билет на загрузку файла.
   *
   * Запись о материале создаётся ДО загрузки и остаётся в статусе `queued`:
   * ключ объекта должен существовать в подписи, а подпись — принадлежать
   * конкретной записи. Материал без фактически загруженного объекта виден как
   * незавершённый, а не как «есть файл».
   */
  async requestUpload(ctx: RequestContext, input: RequestUpload): Promise<UploadTicket> {
    if (!this.s3.isConfigured) {
      throw errors.featureDisabled('media_upload');
    }
    const maxBytes = MAX_UPLOAD_BYTES[input.type];
    if (input.sizeBytes > maxBytes) {
      throw errors.validation([
        { path: 'sizeBytes', message: `для типа ${input.type} максимум ${maxBytes} байт` },
      ]);
    }

    return this.runMapped(async () =>
      this.db.transaction(ctx, async (tx) => {
        await this.assertProjectVisible(tx, input.projectId);
        const version = await this.nextMaterialVersion(tx, input.projectId, input.type);
        const materialId = uuidv7();
        const key = this.s3.buildMaterialKey(input.projectId, materialId, input.type);

        await tx.query(
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, s3_key, parse_status, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, 'queued', $6)`,
          [materialId, input.projectId, input.type, version, key, ctx.userId],
        );

        await this.audit.emit(tx, {
          verb: 'lab.material.added',
          actorId: ctx.userId,
          actorRole: 'founder',
          subjectType: 'project',
          subjectId: input.projectId,
          context: { type: input.type, sizeBytes: input.sizeBytes },
          traceId: ctx.traceId,
        });

        const form = this.s3.presignUpload({
          key,
          contentType: input.contentType,
          maxBytes,
        });

        return {
          materialId,
          uploadUrl: form.url,
          method: 'POST' as const,
          formFields: form.fields,
          maxSizeBytes: maxBytes,
          expiresAt: form.expiresAt.toISOString(),
        };
      }),
    );
  }

  // -------------------------------------------------------------------- листинг

  async publishListing(ctx: RequestContext, projectId: string): Promise<ProjectFull> {
    return this.runMapped(async () =>
      this.db.transaction(ctx, async (tx) => {
        const { rows: found } = await tx.query<{
          investment_ask: string;
          listing_status: string;
          owner_id: string | null;
        }>(
          `SELECT p.investment_ask::text AS investment_ask, p.listing_status,
                  (SELECT fp.user_id FROM lab.founders_projects fp
                    WHERE fp.project_id = p.id AND fp.role = 'owner') AS owner_id
             FROM lab.projects p
            WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [projectId],
        );
        const project = found[0];
        if (!project) throw errors.notFound({ subject: 'project' });
        if (project.listing_status === 'listed') {
          return this.reread(tx, projectId);
        }

        // KYC владельца — условие публикации, а не формальность: карточку
        // увидят инвесторы, и за ней должен стоять проверенный человек.
        const kyc = await tx.query<{ valid: boolean }>(
          'SELECT kyc.has_valid_kyc($1, $2) AS valid',
          [project.owner_id, 'identity'],
        );
        if (!kyc.rows[0]?.valid) throw errors.kycRequired();

        // Тариф пересчитывается прямо здесь: между созданием проекта и
        // публикацией могла смениться версия тарифной сетки.
        const planId = await resolveFounderPlan(tx, project.investment_ask);

        const subscription = await tx.query<{ ok: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM billing.subscriptions s
              WHERE s.project_id = $1 AND s.user_id = $2
                AND s.plan_id = $3 AND s.status = 'active') AS ok`,
          [projectId, project.owner_id, planId],
        );
        if (!subscription.rows[0]?.ok) {
          throw errors.subscriptionRequired();
        }

        await tx.query(
          `UPDATE lab.projects
              SET listing_status = 'listed', listed_at = now(),
                  required_plan_id = $2, updated_at = now()
            WHERE id = $1`,
          [projectId, planId],
        );

        await this.audit.record(tx, {
          verb: 'lab.listing.published',
          actorId: ctx.userId,
          actorRole: 'founder',
          aggregateType: 'project',
          aggregateId: projectId,
          aggregateVersion: 1,
          payload: {
            projectId,
            investmentAsk: project.investment_ask,
            currency: 'RUB',
          },
          traceId: ctx.traceId,
        });

        return this.reread(tx, projectId);
      }),
    );
  }

  async unpublishListing(ctx: RequestContext, projectId: string): Promise<ProjectFull> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<ProjectRow>(
        `UPDATE lab.projects
            SET listing_status = 'unlisted', updated_at = now()
          WHERE id = $1 AND deleted_at IS NULL AND listing_status = 'listed'
          RETURNING ${PROJECT_COLUMNS}`,
        [projectId],
      );
      const row = rows[0];
      if (!row) {
        // Либо проекта нет, либо он и не был опубликован. Различать эти случаи
        // наружу незачем.
        throw errors.notFound({ subject: 'listing' });
      }

      await this.audit.record(tx, {
        verb: 'lab.listing.unpublished',
        actorId: ctx.userId,
        actorRole: 'founder',
        aggregateType: 'project',
        aggregateId: projectId,
        aggregateVersion: 2,
        payload: { projectId },
        traceId: ctx.traceId,
      });

      return mapProject(row);
    });
  }

  // ------------------------------------------------------------------ private

  private async reread(tx: Tx, projectId: string): Promise<ProjectFull> {
    const { rows } = await tx.query<ProjectRow>(
      `SELECT ${PROJECT_COLUMNS} FROM lab.projects WHERE id = $1`,
      [projectId],
    );
    return mapProject(rows[0]!);
  }

  private async assertProjectVisible(tx: Tx, projectId: string): Promise<void> {
    const { rows } = await tx.query(
      'SELECT 1 FROM lab.projects WHERE id = $1 AND deleted_at IS NULL',
      [projectId],
    );
    if (rows.length === 0) throw errors.notFound({ subject: 'project' });
  }

  private async nextMaterialVersion(tx: Tx, projectId: string, type: string): Promise<number> {
    const { rows } = await tx.query<{ next_version: string }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
         FROM lab.project_materials WHERE project_id = $1 AND type = $2`,
      [projectId, type],
    );
    return Number(rows[0]?.next_version ?? 1);
  }

  /**
   * Переводит отказ БД в доменную ошибку.
   *
   * Инварианты листинга живут в отложенных триггерах, поэтому срабатывают на
   * COMMIT — уже за пределами конкретного запроса. Без этого перевода наружу
   * ушла бы 500 с текстом исключения PostgreSQL, то есть и бесполезный ответ
   * клиенту, и утечка внутреннего устройства.
   */
  private async runMapped<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      const pg = error as { code?: string; message?: string };
      const message = pg.message ?? '';
      if (pg.code === '23514' && message.includes('required_plan_id does not match')) {
        throw errors.planUpgradeRequired(
          'Запрос инвестиций превысил лимит тарифа: требуется переход на старший тариф',
        );
      }
      if (pg.code === '42501' && message.includes('listing requires an active subscription')) {
        throw errors.subscriptionRequired();
      }
      if (pg.code === '23505') {
        throw errors.conflict('Такая запись уже существует', { constraint: pg.code });
      }
      if (pg.code === '42501') {
        throw errors.forbidden({ stage: 'db-policy' });
      }
      throw error;
    }
  }
}

// -------------------------------------------------------------------- helpers

/**
 * Резолвер тарифа — в БД, а не в коде.
 *
 * Тарифная сетка версионируется, и сервер обязан брать ту версию, что
 * действует сейчас. Дублирование таблицы порогов в TypeScript означало бы два
 * источника цены и неизбежное расхождение.
 */
async function resolveFounderPlan(tx: Tx, ask: string): Promise<string> {
  const { rows } = await tx.query<{ plan_id: string | null }>(
    'SELECT billing.resolve_founder_plan($1::numeric) AS plan_id',
    [ask],
  );
  const planId = rows[0]?.plan_id ?? null;
  if (!planId) {
    throw errors.internal({ reason: 'no active founder plan for ask', ask });
  }
  return planId;
}

const PROJECT_COLUMNS = `
  id, taxonomy_id, title, tagline, description, stage, geo_country, geo_region,
  investment_ask::text AS investment_ask, ask_currency, required_plan_id,
  listing_status, listed_at, status, season_id, current_version_id, created_at, updated_at
`;

interface ProjectRow {
  id: string;
  taxonomy_id: string | null;
  title: string;
  tagline: string | null;
  description: string | null;
  stage: ProjectFull['stage'];
  geo_country: string | null;
  geo_region: string | null;
  investment_ask: string;
  ask_currency: string;
  required_plan_id: string | null;
  listing_status: ProjectFull['listingStatus'];
  listed_at: Date | null;
  status: ProjectFull['status'];
  season_id: string | null;
  current_version_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ProjectSummaryRow {
  id: string;
  title: string;
  stage: ProjectSummary['stage'];
  status: ProjectSummary['status'];
  listing_status: ProjectSummary['listingStatus'];
  investment_ask: string;
  ask_currency: string;
  required_plan_id: string | null;
  required_plan_code: string | null;
  role: 'owner' | 'cofounder';
  created_at: Date;
}

interface VersionRow {
  id: string;
  project_id: string;
  season_id: string;
  version_no: number;
  submitted_at: Date;
}

interface MaterialRow {
  id: string;
  project_id: string;
  type: ProjectMaterial['type'];
  version: number;
  url: string | null;
  parse_status: ProjectMaterial['parseStatus'];
  created_at: Date;
}

function mapProject(row: ProjectRow): ProjectFull {
  return {
    id: row.id,
    title: row.title,
    tagline: row.tagline,
    stage: row.stage,
    taxonomyId: row.taxonomy_id,
    geoCountry: row.geo_country,
    investmentAsk: row.investment_ask,
    askCurrency: row.ask_currency as 'RUB',
    listedAt: row.listed_at?.toISOString() ?? null,
    description: row.description,
    geoRegion: row.geo_region,
    status: row.status,
    listingStatus: row.listing_status,
    seasonId: row.season_id,
    requiredPlanId: row.required_plan_id,
    currentVersionId: row.current_version_id,
    // Скоринга в этой фазе нет. `null` честнее нуля: ноль читается как оценка.
    irs: null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `s3_key` наружу не отдаётся: путь в хранилище — внутренняя деталь. */
function mapMaterial(row: MaterialRow): ProjectMaterial {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    version: row.version,
    url: row.url,
    parseStatus: row.parse_status,
    createdAt: row.created_at.toISOString(),
  };
}
