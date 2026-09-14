import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  MATERIAL_UPLOAD_RULES,
  type UploadableMaterialType,
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
import { getEnv } from '../config/env';
import { ApplicationsService } from './applications.service';
import { VERSION_COLUMNS, mapVersion, type VersionRow } from './versions';

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
/**
 * Предел числа материалов на проект. Не «красивое число»: заявка с полусотней
 * приложений не читается человеком, а рецензент обязан её прочесть.
 */
const MAX_MATERIALS_PER_PROJECT = 50;

/** Незавершённых загрузок одновременно: больше — это уже не работа, а запас. */
const MAX_PENDING_UPLOADS_PER_PROJECT = 5;

/**
 * Лимиты и MIME — из контрактов (MATERIAL_UPLOAD_RULES): один источник правды
 * для DTO, сервера и интерфейсов (CODE-HIGH-09/CODE-MED-02).
 */
const MAX_UPLOAD_BYTES: Record<UploadableMaterialType, number> = {
  deck: MATERIAL_UPLOAD_RULES.deck.maxBytes,
  video: MATERIAL_UPLOAD_RULES.video.maxBytes,
  doc: MATERIAL_UPLOAD_RULES.doc.maxBytes,
};

/**
 * Сигнатуры форматов по типу материала. Заявленный Content-Type — слово
 * клиента; подписанная форма фиксирует заголовок, но не содержимое
 * (SEC-HIGH-02). Первые байты объекта обязаны соответствовать одному из
 * форматов, допустимых для типа, иначе подтверждение отказывает.
 */
const MATERIAL_SIGNATURES: Record<UploadableMaterialType, (head: Buffer) => boolean> = {
  // %PDF- либо контейнер OOXML (pptx — это zip: PK\x03\x04).
  deck: (head) => isPdf(head) || isZip(head),
  // ISO BMFF: 'ftyp' по смещению 4.
  video: (head) => head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp',
  // Скан или документ: pdf, png, jpeg.
  doc: (head) => isPdf(head) || isPng(head) || isJpeg(head),
};

const isPdf = (head: Buffer) => head.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (head: Buffer) => head.length >= 4 && head.readUInt32BE(0) === 0x504b0304;
const isPng = (head: Buffer) =>
  head.length >= 8 && head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
const isJpeg = (head: Buffer) =>
  head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly s3: S3Service,
    private readonly applications: ApplicationsService,
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

      // С M071 у проекта с первой секунды есть заявка — как у перенесённых:
      // схема 0, поля из проекта. Кабинет v1 её не видит, но подача через
      // старый маршрут и список заявок v2 работают одинаково для старых и
      // новых проектов.
      const applicationId = uuidv7();
      await tx.query(
        `INSERT INTO lab.investment_applications
           (id, project_id, stage, investment_ask, ask_currency, schema_version,
            answers_jsonb, created_by)
         VALUES ($1, $2, $3, $4::numeric, $5, 0, $6::jsonb, $7)`,
        [
          applicationId,
          id,
          input.stage,
          input.investmentAsk,
          input.askCurrency,
          JSON.stringify(input.description ? { description: input.description } : {}),
          ctx.userId,
        ],
      );
      await tx.query(`UPDATE lab.projects SET current_application_id = $2 WHERE id = $1`, [
        id,
        applicationId,
      ]);

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

        // Кабинет v1 правит сумму и стадию на проекте; с M071 они живут в
        // текущей заявке, а проект — производный кеш. Чтобы v1 не расходился с
        // заявкой (следующая проекция вернула бы старое значение), правка
        // переносится в текущую незаархивированную заявку схемы 0.
        if (input.investmentAsk !== undefined || input.stage !== undefined) {
          await tx.query(
            `UPDATE lab.investment_applications
                SET investment_ask = COALESCE($2::numeric, investment_ask),
                    stage          = COALESCE($3, stage)
              WHERE id = (SELECT current_application_id FROM lab.projects WHERE id = $1)
                AND status <> 'archived' AND schema_version = 0`,
            [projectId, input.investmentAsk ?? null, input.stage ?? null],
          );
        }

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
   * Подача проекта в сезон — старый маршрут, теперь обёртка над подачей
   * заявки (план 0.2 §2.14, коммит 2.3).
   *
   * Поведение для кабинета v1 не меняется: требуется открытый сезон, проект
   * должен быть в `draft` или `submitted`, снимок неизменяем, проект получает
   * `season_id`. Что изменилось внутри: снимок делает сервис заявок по
   * ТЕКУЩЕЙ заявке проекта (после переноса M071 она есть у каждого), а
   * политика ограничений здесь не проверяется — v1 работает как прежде до
   * переключения на v2.
   */
  async submit(ctx: RequestContext, projectId: string): Promise<ProjectVersion> {
    return this.db.transaction(ctx, async (tx) => {
      // Лок на проект: два параллельных submit считали ОДИН и тот же
      // version_no, второй падал на UNIQUE и наружу уходил 500 вместо
      // доменного отказа (LOW внешнего аудита №2). Тот же ключ, что у
      // остальных путей, меняющих материалы и версии проекта.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `project-write:${projectId}`,
      ]);
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

      // Текущая заявка проекта; если её нет (проект создан мимо переноса) —
      // последняя незаархивированная, иначе заявка из полей проекта, как её
      // создал бы перенос M071.
      let applicationId = project.current_application_id;
      if (!applicationId) {
        const { rows } = await tx.query<{ id: string }>(
          `SELECT id FROM lab.investment_applications
            WHERE project_id = $1 AND status <> 'archived'
            ORDER BY created_at DESC LIMIT 1`,
          [projectId],
        );
        applicationId = rows[0]?.id ?? null;
      }
      if (!applicationId) {
        applicationId = uuidv7();
        await tx.query(
          `INSERT INTO lab.investment_applications
             (id, project_id, stage, investment_ask, ask_currency, schema_version,
              answers_jsonb, created_by)
           VALUES ($1, $2, $3, $4::numeric, $5, 0, $6::jsonb, $7)`,
          [
            applicationId,
            projectId,
            project.stage,
            project.investment_ask,
            project.ask_currency,
            JSON.stringify(project.description ? { description: project.description } : {}),
            ctx.userId,
          ],
        );
      }

      const version = await this.applications.submitInTx(tx, ctx, applicationId, {
        seasonId,
        enforcePolicy: false,
      });

      // Событие проекта сохраняется ради потребителей старого пути; версия
      // агрегата — по счётчику, а не по номеру версии: у двух заявок одного
      // проекта номера версий совпадают.
      await this.audit.record(tx, {
        verb: 'lab.project.submitted',
        actorId: ctx.userId,
        actorRole: 'founder',
        aggregateType: 'project',
        aggregateId: projectId,
        aggregateVersion: await this.audit.nextAggregateVersion(
          tx,
          'project',
          projectId,
          'lab.project.submitted',
        ),
        payload: { projectId, seasonId, versionNo: version.versionNo, applicationId },
        traceId: ctx.traceId,
      });

      return version;
    });
  }

  /**
   * История поданных версий заявки.
   *
   * Отдаются только метаданные: сам снимок (`snapshot_jsonb`) — это заявка
   * целиком, и её содержимое читается через карточку проекта, где действуют
   * собственные правила видимости. Кто увидит список, решает RLS: владелец,
   * админ, организатор и назначенный рецензент (M025).
   */
  async listVersions(ctx: RequestContext, projectId: string): Promise<ProjectVersion[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<VersionRow>(
        `SELECT ${VERSION_COLUMNS}
           FROM lab.project_versions
          WHERE project_id = $1
          ORDER BY submitted_at DESC, version_no DESC
          LIMIT 100`,
        [projectId],
      );
      return rows.map(mapVersion);
    });
  }

  /**
   * Квота проекта на материалы.
   *
   * Без неё авторизованный пользователь выпускает билеты сколько угодно: каждая
   * выдача создаёт строку и объект в хранилище, и рост ограничен только его
   * терпением (SEC-14). Считаются и незавершённые загрузки — иначе квота
   * обходится тем, что файлы просто не досылаются.
   */
  private async assertUploadQuota(tx: Tx, projectId: string): Promise<void> {
    // Блокировка на проект берётся ДО подсчёта. Без неё предел обходится
    // параллелизмом: одновременные запросы читают одно и то же число и все
    // проходят проверку. Воспроизведено — проект с 4 незавершёнными загрузками
    // при пределе 5 получил ещё две и оказался на 6.
    //
    // Тот же приём уже применён к квотам этапа сезона: advisory-лок в рамках
    // транзакции сериализует именно этот проект, не мешая остальным.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `material-quota:${projectId}`,
    ]);

    // Счёт идёт через SECURITY DEFINER-функцию (M057), а не прямым SELECT:
    // политика материалов (M056) скрывает неподтверждённые строки от чтения,
    // и прямой подсчёт видел бы ноль — предел незавершённых загрузок молча
    // перестал бы действовать. Поймано зондом уборки, не ревью.
    const { rows } = await tx.query<{ total: string; pending: string }>(
      `SELECT total::text AS total, pending::text AS pending
         FROM lab.material_counters($1)`,
      [projectId],
    );
    const total = Number(rows[0]!.total);
    const pending = Number(rows[0]!.pending);

    if (total >= MAX_MATERIALS_PER_PROJECT) {
      throw errors.limitExceeded(
        `У проекта уже ${total} материалов при пределе ${MAX_MATERIALS_PER_PROJECT}`,
      );
    }
    // Отдельный предел на НЕЗАВЕРШЁННЫЕ: цепочка выданных и брошенных билетов
    // — самый дешёвый способ занять место, ничего не загружая.
    if (pending >= MAX_PENDING_UPLOADS_PER_PROJECT) {
      throw errors.limitExceeded(
        `У проекта ${pending} незавершённых загрузок. Завершите или дождитесь их отмены`,
      );
    }
  }

  /**
   * Подтверждение загрузки.
   *
   * До этого вызова строка материала — намерение, а не материал: билет мог быть
   * выдан и не использован. Факт проверяется обращением к хранилищу, а не
   * словами клиента: «я загрузил» от клиента — это не доказательство.
   */
  async finalizeUpload(
    ctx: RequestContext,
    projectId: string,
    materialId: string,
  ): Promise<ProjectMaterial> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<MaterialRow & { s3_key: string | null }>(
        // FOR UPDATE обязателен. Без блокировки между этим чтением и записью
        // ниже успевает вклиниться уборщик брошенных загрузок: он удаляет
        // объект в хранилище, а подтверждение затем проставляет `uploaded_at` —
        // и получается «готовый» материал без файла (SEC-04). Блокировка
        // сериализует подтверждение и уборку одной строки.
        `SELECT id, project_id, type, version, url, parse_status, created_at, s3_key, uploaded_at
           FROM lab.project_materials
          WHERE id = $1 AND project_id = $2
            FOR UPDATE`,
        [materialId, projectId],
      );
      const material = rows[0] as
        (MaterialRow & { s3_key: string | null; uploaded_at: Date | null }) | undefined;
      if (!material) throw errors.notFound({ subject: 'material' });
      if (!material.s3_key) {
        throw errors.conflict('Этот материал не требует подтверждения загрузки');
      }

      // Повторное подтверждение уже подтверждённого материала возвращает
      // запись КАК ЕСТЬ, не перечитывая объект: getObjectDigest тянет тело
      // целиком (до 500 МБ), и владелец проекта мог крутить finalize в цикле,
      // расходуя egress хранилища и I/O ядра (LOW внешнего аудита №2).
      // Отпечаток и размер зафиксированы при первом подтверждении и
      // перезаписи не подлежат — перечитывать нечего.
      if (material.uploaded_at) return mapMaterial(material);

      // Подтверждение имеет срок. Без него билет, переживший все проходы
      // уборки, можно подтвердить когда угодно — и материал, который система
      // уже считает мусором и чей объект могла удалить, вернулся бы в оборот
      // «готовым» (CODE-05). Срок тот же, по которому работает уборка: за его
      // пределами материала уже нет с точки зрения платформы.
      const ttlHours = getEnv().MATERIAL_ABANDONED_TTL_HOURS;
      const ageMs = Date.now() - material.created_at.getTime();
      if (ageMs > ttlHours * 3600_000) {
        throw errors.conflict(
          `Срок подтверждения загрузки истёк (${ttlHours} ч): запроси новый билет`,
        );
      }

      // Объект читается ПОТОКОМ целиком: отпечаток — настоящий sha256 по
      // фактическим байтам, а не ETag (ETag не криптографический digest:
      // multipart и SSE меняют его семантику — SEC-HIGH-03), а первые байты
      // сверяются с сигнатурой формата, допустимого для типа материала
      // (SEC-HIGH-02): заявленный Content-Type — слово клиента, содержимое —
      // нет.
      const object = await this.s3.getObjectDigest(material.s3_key);
      if (!object.exists) {
        throw errors.conflict('Объект не найден в хранилище: загрузка не завершена');
      }
      const signatureOk = MATERIAL_SIGNATURES[material.type as UploadableMaterialType];
      if (!signatureOk || !signatureOk(object.head)) {
        throw errors.conflict(
          `Содержимое файла не соответствует типу материала «${material.type}»: ` +
            'загрузите файл допустимого формата',
        );
      }

      const { rows: updated } = await tx.query<MaterialRow>(
        // Отпечаток пишется только при первом подтверждении — тем же
        // `coalesce`, что и момент загрузки: повторный вызов не должен
        // переписывать зафиксированное состояние новым содержимым объекта.
        `UPDATE lab.project_materials
            SET uploaded_at = coalesce(uploaded_at, now()),
                size_bytes = $3,
                content_hash = coalesce(content_hash, $4)
          WHERE id = $1 AND project_id = $2
        RETURNING id, project_id, type, version, url, parse_status, created_at`,
        [materialId, projectId, object.sizeBytes, `sha256:${object.sha256}`],
      );
      // Строки может не быть, если её убрали между чтением и записью. Прежний
      // код брал `updated[0]!` и падал внутренней ошибкой; отказ должен быть
      // объяснимым.
      if (!updated[0]) {
        throw errors.conflict('Материал был удалён во время подтверждения загрузки');
      }

      await this.audit.emit(tx, {
        verb: 'lab.material.added',
        actorId: ctx.userId,
        actorRole: 'founder',
        subjectType: 'project',
        subjectId: projectId,
        context: { materialId, sizeBytes: object.sizeBytes, finalized: true },
        traceId: ctx.traceId,
      });

      return mapMaterial(updated[0]);
    });
  }

  // ------------------------------------------------------------------ материалы

  async listMaterials(ctx: RequestContext, projectId: string): Promise<ProjectMaterial[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<MaterialRow>(
        // Только подтверждённые: выданный и брошенный билет не материал, и
        // показывать его как материал значит вводить в заблуждение и
        // основателя, и рецензента.
        `SELECT id, project_id, type, version, url, parse_status, created_at
           FROM lab.project_materials
          WHERE project_id = $1 AND uploaded_at IS NOT NULL
          ORDER BY created_at DESC
          LIMIT 100`,
        [projectId],
      );
      return rows.map(mapMaterial);
    });
  }

  /**
   * Содержимое материала для просмотра ВНУТРИ платформы.
   *
   * Доступ решает RLS: файл увидит участник проекта, администратор,
   * организатор, назначенный рецензент и инвестор с активной подпиской по
   * опубликованному листингу (M065). Если политика не пускает — строки просто
   * не будет, и ответ ничем не отличается от «такого материала нет».
   *
   * Ядро отдаёт байты само и НЕ выписывает presigned-ссылку на хранилище:
   * такая ссылка живёт своей жизнью — переживает окончание подписки, снятие
   * листинга и пересылается кому угодно. Здесь же доступ проверяется на каждом
   * запросе.
   */
  async getMaterialContent(
    ctx: RequestContext,
    projectId: string,
    materialId: string,
  ): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const key = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ s3_key: string | null; type: string }>(
        `SELECT s3_key, type FROM lab.project_materials
          WHERE id = $1 AND project_id = $2 AND uploaded_at IS NOT NULL`,
        [materialId, projectId],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'material' });
      if (!row.s3_key) {
        // Ссылка на продукт — это адрес, а не файл: открывать её должен сам
        // браузер, а не платформа своим запросом (иначе ядро станет прокси в
        // произвольный интернет — готовый SSRF).
        throw errors.conflict('Этот материал — внешняя ссылка, а не файл');
      }
      return { key: row.s3_key, type: row.type };
    });

    const object = await this.s3.getObject(key.key);
    if (!object) throw errors.notFound({ subject: 'material' });

    // Тип берём из хранилища, но принимаем только то, что браузер показывает
    // сам. Чужой content-type здесь означал бы отдачу HTML с нашего адреса.
    const allowed = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
    const contentType =
      object.contentType && allowed.has(object.contentType)
        ? object.contentType
        : 'application/pdf';

    return {
      body: object.body,
      contentType,
      filename: `${key.type}-${materialId}`,
    };
  }

  async addProductLink(ctx: RequestContext, input: AddProductLink): Promise<ProjectMaterial> {
    return this.runMapped(async () =>
      this.db.transaction(ctx, async (tx) => {
        await this.assertProjectVisible(tx, input.projectId);
        // Тот же лок, что берёт проверка квоты на втором пути создания
        // материала. Без него два одновременных добавления ссылки считают ОДНУ
        // следующую версию, и второе упирается в `UNIQUE (project_id, type,
        // version)`: пользователь получает «такая запись уже существует» на
        // законное действие, хотя ссылка другая и версия должна быть следующей
        // (CODE-15). Лок сериализует только этот проект.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `material-quota:${input.projectId}`,
        ]);
        const version = await this.nextMaterialVersion(tx, input.projectId, 'product_link');
        const id = uuidv7();

        const { rows } = await tx.query<MaterialRow>(
          // `uploaded_at` проставляется явно: ссылка не проходит через
          // хранилище, поэтому момент её создания и есть момент загрузки. Без
          // отметки материал считался бы намерением и не показывался бы ни
          // владельцу, ни рецензенту (M037/M040). То же правило продублировано
          // триггером БД — сервисный слой здесь не единственная защита.
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, url, parse_status, uploaded_by, uploaded_at)
           VALUES ($1, $2, 'product_link', $3, $4, 'not_required', $5, now())
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
        await this.assertUploadQuota(tx, input.projectId);
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

        // Платёжный барьер — флаг, а не удаление (M071, план 0.2 §2.9.2): по
        // решению владельца в первой очереди подача и листинг бесплатны. При
        // включённом флаге проверка та же, что раньше; триггер БД повторяет
        // её на COMMIT. Доступ инвестора от флага не зависит.
        const barrier = await tx.query<{ on: boolean }>(
          'SELECT lab.listing_requires_subscription() AS "on"',
        );
        if (barrier.rows[0]?.on) {
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
        }

        // Флаги комплаенса в действующем паспорте останавливают публикацию до
        // решения человека (ADR-008 §4). Обещание гарантированной доходности —
        // это не минус балл, а признак, требующий остановки: и по обязанностям
        // оператора, и по признакам финансовой пирамиды, и по требованиям к
        // рекламе финансовых услуг. Решение принимается в очереди комплаенса.
        const compliance = await tx.query<{ status: string | null; flags: string[] | null }>(
          `SELECT jsonb_data->'complianceReview'->>'status' AS status,
                  ARRAY(SELECT jsonb_array_elements_text(COALESCE(jsonb_data->'complianceFlags', '[]'::jsonb))) AS flags
             FROM scoring.investment_passports
            WHERE project_id = $1 AND superseded_at IS NULL`,
          [projectId],
        );
        const held = compliance.rows[0];
        if (held && (held.flags?.length ?? 0) > 0 && held.status !== 'allowed') {
          throw errors.stateTransition(
            held.status === 'blocked'
              ? 'Публикация закрыта решением комплаенса по признакам, найденным при оценке'
              : 'Публикация приостановлена до решения комплаенса: оценка выявила признаки, требующие проверки человеком',
          );
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
          // Листинг публикуется и снимается многократно: постоянная «1» на
          // второй публикации конфликтовала бы с первой (CODE-06).
          aggregateVersion: await this.audit.nextAggregateVersion(
            tx,
            'project',
            projectId,
            'lab.listing.published',
          ),
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
        aggregateVersion: await this.audit.nextAggregateVersion(
          tx,
          'project',
          projectId,
          'lab.listing.unpublished',
        ),
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
    // Та же причина, что и у квоты (M057): под политикой M056 прямой MAX
    // считал бы только подтверждённые версии, и номер повторялся бы —
    // вставка падала на UNIQUE (project_id, type, version).
    const { rows } = await tx.query<{ next_version: string }>(
      `SELECT lab.next_material_version($1, $2)::text AS next_version`,
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
  listing_status, listed_at, status, season_id, current_version_id, current_application_id,
  created_at, updated_at,
  (SELECT s.value::text
     FROM scoring.irs_scores s
    WHERE s.project_id = lab.projects.id
    ORDER BY s.computed_at DESC
    LIMIT 1) AS irs
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
  current_application_id: string | null;
  created_at: Date;
  updated_at: Date;
  /** Последний IRS проекта; NUMERIC приходит строкой, чтобы не терять точность. */
  irs: string | null;
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
    currentApplicationId: row.current_application_id,
    // Последний рассчитанный IRS проекта. Раньше здесь стоял жёсткий `null` с
    // припиской «скоринга в этой фазе нет» — скоринг появился, а строка
    // осталась, и кабинет показывал «IRS ещё не рассчитан» рядом с посчитанным
    // паспортом. `null` по-прежнему честнее нуля: ноль читается как оценка.
    irs: row.irs === null || row.irs === undefined ? null : Number(row.irs),
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
