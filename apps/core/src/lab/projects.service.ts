import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type AddProductLink,
  type CreateProjectRequest,
  type ProjectFull,
  type ProjectMaterial,
  type MaterialUploadResult,
  type ProjectSummary,
  type RequestUpload,
  type UpdateProjectRequest,
  type UploadTicket,
} from '@unicorn/contracts';
import { AppError, errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { S3Service } from '../storage/s3.service';
import { MAX_UPLOAD_BYTES } from './material-rules';
import { MaterialUploadsService } from './material-uploads.service';

/**
 * Проекты и листинги основателя.
 *
 * Публикация — не смена флага, а прохождение условий: действующая проверка
 * личности владельца.
 */

/** Предел числа материалов на проект: полсотни приложений человек не прочтёт. */
const MAX_MATERIALS_PER_PROJECT = 50;

/** Незавершённых загрузок одновременно: больше — это уже не работа, а запас. */
const MAX_PENDING_UPLOADS_PER_PROJECT = 5;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly s3: S3Service,
    private readonly uploads: MaterialUploadsService,
  ) {}

  async create(ctx: RequestContext, input: CreateProjectRequest): Promise<ProjectFull> {
    const id = uuidv7();
    return this.db.transaction(ctx, async (tx) => {
      // RETURNING здесь недопустим, и это не стилистика: возврат строки требует
      // прав на SELECT, а видимость проекта даёт запись в founders_projects,
      // которой в этот момент ещё нет. INSERT ... RETURNING упал бы на RLS —
      // причём с сообщением про нарушение политики вставки, уводящим в сторону.
      await tx.query(
        // Происхождение проекта НЕ спрашивается отдельно: оно наследуется у
        // создателя (M127). Проход, заведённый как `render_check`, создаёт
        // проекты того же происхождения — и вычищаются они вместе. Второй
        // вопрос об одном и том же завёл бы второе место правды.
        `INSERT INTO lab.projects
           (id, taxonomy_id, title, tagline, description, stage, geo_country, geo_region,
            investment_ask, ask_currency, origin)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10,
                 coalesce((SELECT origin FROM identity.users WHERE id = app.current_user_id()),
                          'self_registration'))`,
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
        ],
      );

      await tx.query(
        `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [id, ctx.userId],
      );

      // Проект, созданный в тестовой сессии, числится за ней (M129).
      //
      // Без этой записи уборка сессии убрала бы участников, а их проекты
      // остались бы в каталоге: «убрано» без объяснения, почему половина
      // осталась. Перечень ведётся здесь, а не выводится из происхождения:
      // происхождение говорит «запись сессии», но не КАКОЙ.
      if (ctx.testSessionId) {
        // Через функцию: таблица перечня закрыта от участника политикой, и
        // ослаблять её нельзя — иначе любой припишет чужую запись к своей
        // сессии. Функция сама проверяет участие и состояние сессии (M132).
        await tx.query('SELECT testing.track_object($1, $2, $3)', [
          ctx.testSessionId,
          'lab.projects',
          id,
        ]);
      }

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
                fp.role, p.created_at
           FROM lab.founders_projects fp
           JOIN lab.projects p ON p.id = fp.project_id
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
        `У проекта идёт ${pending} передач файлов. Дождитесь их окончания`,
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
  ): Promise<MaterialUploadResult> {
    // Доступ проверяется контекстом пользователя: политика материалов (M056)
    // показывает незавершённую загрузку только её автору и администратору.
    // Чужой идентификатор неотличим от несуществующего.
    const visible = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ type: string }>(
        `SELECT type FROM lab.project_materials WHERE id = $1 AND project_id = $2`,
        [materialId, projectId],
      );
      return rows[0];
    });
    if (!visible) throw errors.notFound({ subject: 'material' });
    if (visible.type === 'product_link') {
      throw errors.conflict('Этот материал не требует подтверждения загрузки');
    }

    // Завершение — общая функция (2.1-W03), та же, что у фоновой сверки.
    // Срока подтверждения больше нет: истечение формы запрещает новую
    // передачу, но не завершение уже полученного файла (2.1.2).
    const outcome = await this.uploads.finalizeFromBrowser(materialId, ctx.userId, ctx.traceId);

    let material: ProjectMaterial | null = null;
    if (outcome.state === 'ready') {
      material = await this.db.readOnly(ctx, async (tx) => {
        const { rows } = await tx.query<MaterialRow>(
          `SELECT id, project_id, type, version, url, created_at, visibility
             FROM lab.project_materials WHERE id = $1 AND project_id = $2`,
          [materialId, projectId],
        );
        return rows[0] ? mapMaterial(rows[0]) : null;
      });
    }
    return {
      uploadState: outcome.state,
      received: outcome.received,
      // Наружу — только причина отклонения: она адресована пользователю.
      // Диагностика вмешательства остаётся во внутренних полях.
      reason: outcome.state === 'rejected' ? outcome.reason : null,
      material,
    };
  }

  async listMaterials(ctx: RequestContext, projectId: string): Promise<ProjectMaterial[]> {
    return this.db.readOnly(ctx, async (tx) => {
      // Недоступный проект — 404, а не пустой список: старый маршрут не
      // должен даже намекать, что проект существует (5.7.5).
      await this.assertProjectVisible(tx, projectId);
      const { rows } = await tx.query<MaterialRow>(
        // Только подтверждённые: выданный и брошенный билет не материал, и
        // показывать его как материал значит вводить в заблуждение и
        // основателя, и рецензента.
        `SELECT id, project_id, type, version, url, created_at, visibility
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
             (id, project_id, type, version, url, uploaded_by, uploaded_at)
           VALUES ($1, $2, 'product_link', $3, $4, $5, now())
           RETURNING id, project_id, type, version, url, created_at, visibility`,
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
        // Форма получает ВРЕМЕННЫЙ ключ: готовый файл создаётся копией по
        // другому ключу при завершении, и повторная отправка формы его не
        // меняет (2.1.2).
        const key = this.s3.buildMaterialUploadKey(input.projectId, materialId, input.type);
        const form = this.s3.presignUpload({
          key,
          contentType: input.contentType,
          maxBytes,
        });

        await tx.query(
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, upload_key, upload_expires_at,
              upload_content_type, upload_max_bytes, next_check_at, uploaded_by,
              upload_file_name)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '1 minute', $9, $10)`,
          [
            materialId,
            input.projectId,
            input.type,
            version,
            key,
            form.expiresAt,
            input.contentType,
            maxBytes,
            ctx.userId,
            // Имя — для сообщений пользователю о ЕГО файле (2.1-W04).
            input.fileName.slice(0, 255),
          ],
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

  /** Старый маршрут листинга: обёртка над режимом `public` (5.7.3). */
  async publishListing(ctx: RequestContext, projectId: string): Promise<ProjectFull> {
    return this.publishAs(ctx, projectId, 'public');
  }

  /**
   * «Кто может видеть проект» (5.7.3, план заявка-04 §3.1). Режим — решение
   * владельца; `listing_status` — его следствие (кеш для v1 и Integration API).
   * Открытые режимы проходят проверки листинга (KYC владельца, комплаенс,
   * барьер по флагу); `selected_investors` — вместе с выдачей разрешений (5.8).
   * Открытие, пауза и закрытие раунда режим не меняют.
   */
  async setVisibility(
    ctx: RequestContext,
    projectId: string,
    mode: ProjectFull['visibility'],
  ): Promise<ProjectFull> {
    if (mode === 'private') return this.unpublishListing(ctx, projectId);
    return this.publishAs(ctx, projectId, mode);
  }

  /**
   * Режим шире `private` проходит одни и те же проверки — включая
   * «выбранных инвесторов» (5.8): за карточкой, которую кто-то увидит,
   * должен стоять проверенный владелец, и остановка комплаенса действует
   * одинаково. Выбранный получатель видит проект, только если ему выдано
   * разрешение (`lab.project_access_grants`), поэтому режим сам по себе
   * ничего не раскрывает; анониму и Integration API он не виден вовсе
   * (предикат с `NULL`-пользователем).
   */
  private async publishAs(
    ctx: RequestContext,
    projectId: string,
    mode: 'public' | 'registered_investors' | 'selected_investors',
  ): Promise<ProjectFull> {
    return this.runMapped(async () =>
      this.db.transaction(ctx, async (tx) => {
        // Режим входит в отпечаток «Применить» — смена режима под тем же локом.
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `project-write:${projectId}`,
        ]);
        const { rows: found } = await tx.query<{
          investment_ask: string;
          listing_status: string;
          visibility: ProjectFull['visibility'];
          owner_id: string | null;
        }>(
          `SELECT p.investment_ask::text AS investment_ask, p.listing_status, p.visibility,
                  (SELECT fp.user_id FROM lab.founders_projects fp
                    WHERE fp.project_id = p.id AND fp.role = 'owner') AS owner_id
             FROM lab.projects p
            WHERE p.id = $1 AND p.deleted_at IS NULL`,
          [projectId],
        );
        const project = found[0];
        if (!project) throw errors.notFound({ subject: 'project' });
        if (project.visibility === mode) {
          return this.reread(tx, projectId);
        }
        if (project.listing_status === 'listed') {
          // Проверки листинга уже пройдены: меняется только аудитория.
          await tx.query(
            `UPDATE lab.projects
                SET visibility = $2, visibility_changed_at = now(), updated_at = now()
              WHERE id = $1`,
            [projectId, mode],
          );
          await this.auditVisibility(ctx, tx, projectId, project.visibility, mode);
          return this.reread(tx, projectId);
        }

        // KYC владельца — условие публикации, а не формальность: карточку
        // увидят инвесторы, и за ней должен стоять проверенный человек.
        const kyc = await tx.query<{ valid: boolean }>(
          'SELECT kyc.has_valid_kyc($1, $2) AS valid',
          [project.owner_id, 'identity'],
        );
        if (!kyc.rows[0]?.valid) throw errors.kycRequired();

        // Доступ наружу решает режим видимости (lab.project_audience, M087),
        // листинг — его следствие и кеш для v1 и Integration API.
        await tx.query(
          `UPDATE lab.projects
              SET listing_status = 'listed', listed_at = now(),
                  visibility = $2, visibility_changed_at = now(), updated_at = now()
            WHERE id = $1`,
          [projectId, mode],
        );
        await this.auditVisibility(ctx, tx, projectId, project.visibility, mode);

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
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `project-write:${projectId}`,
      ]);
      const { rows: before } = await tx.query<{ visibility: ProjectFull['visibility'] }>(
        `SELECT visibility FROM lab.projects WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const { rows } = await tx.query<ProjectRow>(
        `UPDATE lab.projects
            SET listing_status = 'unlisted', updated_at = now(),
                visibility = 'private', visibility_changed_at = now()
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
      await this.auditVisibility(ctx, tx, projectId, before[0]?.visibility ?? 'public', 'private');

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

  private async auditVisibility(
    ctx: RequestContext,
    tx: Tx,
    projectId: string,
    from: ProjectFull['visibility'],
    to: ProjectFull['visibility'],
  ): Promise<void> {
    await this.audit.emit(tx, {
      verb: 'lab.project.visibility_changed',
      actorId: ctx.userId,
      actorRole: ctx.roles.includes('admin') ? 'admin' : 'founder',
      subjectType: 'project',
      subjectId: projectId,
      context: { from, to },
      traceId: ctx.traceId,
    });
  }

  /**
   * Отметка материала (5.7.3): показывать допущенным инвесторам или только
   * команде. Привязка материала как подтверждения к ответу сама по себе его
   * не открывает — только эта отметка.
   */
  async setMaterialVisibility(
    ctx: RequestContext,
    projectId: string,
    materialId: string,
    visibility: 'private' | 'investors',
  ): Promise<ProjectMaterial> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<MaterialRow>(
        `UPDATE lab.project_materials
            SET visibility = $3
          WHERE id = $2 AND project_id = $1 AND uploaded_at IS NOT NULL
          RETURNING id, project_id, type, version, url, created_at, visibility`,
        [projectId, materialId, visibility],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'material' });
      await this.audit.emit(tx, {
        verb: 'lab.project_material.visibility_changed',
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : 'founder',
        subjectType: 'project',
        subjectId: projectId,
        context: { materialId, visibility },
        traceId: ctx.traceId,
      });
      return mapMaterial(row);
    });
  }

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

const PROJECT_COLUMNS = `
  id, taxonomy_id, title, tagline, description, stage, geo_country, geo_region,
  investment_ask::text AS investment_ask, ask_currency,
  listing_status, listed_at, status, visibility, created_at, updated_at
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
  listing_status: ProjectFull['listingStatus'];
  listed_at: Date | null;
  status: ProjectFull['status'];
  visibility: ProjectFull['visibility'];
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
  role: 'owner' | 'cofounder';
  created_at: Date;
}

interface MaterialRow {
  id: string;
  project_id: string;
  type: ProjectMaterial['type'];
  version: number;
  url: string | null;
  created_at: Date;
  visibility: ProjectMaterial['visibility'];
}

function mapProject(row: ProjectRow): ProjectFull {
  return {
    id: row.id,
    title: row.title,
    tagline: row.tagline,
    stage: row.stage,
    // Наличие логотипа эта выборка не знает: кабинет спрашивает `/media`
    // отдельно и показывает то, что есть на самом деле.
    logoUrl: null,
    taxonomyId: row.taxonomy_id,
    geoCountry: row.geo_country,
    investmentAsk: row.investment_ask,
    askCurrency: row.ask_currency.trim() as 'RUB',
    listedAt: row.listed_at?.toISOString() ?? null,
    description: row.description,
    geoRegion: row.geo_region,
    status: row.status,
    listingStatus: row.listing_status,
    visibility: row.visibility,
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
    visibility: row.visibility,
    createdAt: row.created_at.toISOString(),
  };
}
