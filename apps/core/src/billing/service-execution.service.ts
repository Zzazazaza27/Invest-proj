import { Injectable, Logger } from '@nestjs/common';
import { uuidv7, type ServiceRunAvailability, type ServiceRunView } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { AnalysisService } from '../ai/analysis.service';

/**
 * Исполнение услуги, которую выполняет платформа (этап 6.1; структуры M111).
 *
 * Сегодня такая услуга одна — ИИ-разбор заявки. Сервис не считает и не
 * анализирует ничего сам: разбор живёт в `AnalysisService` (шлюз — единственный
 * выход к моделям, ADR-007), а здесь — связь этого разбора с ОПЛАЧЕННОЙ
 * позицией покупки и честное состояние для основателя.
 *
 * Правила, ради которых сервис существует:
 *
 *  • **услуга закрывается результатом, а не отметкой.** «Выполнено»
 *    появляется только после успешного прогона с сохранённым отчётом; для
 *    услуг платформы отметка руками запрещена базой (M111);
 *  • **отчёт относится к версии.** Прогон запоминает, по какой версии заявки
 *    и какому отпечатку входа он сделан. Правка заявки после разбора старый
 *    отчёт не отменяет и не обновляет — она делает его отчётом о прошлом;
 *  • **повтор не создаёт второго исполнения.** Идущий прогон возвращается как
 *    есть, завершённый успехом — тоже;
 *  • **нет разбора — нет обещаний.** Если контур ИИ не настроен, запуск
 *    отказывает и НАЗЫВАЕТ причину, а не изображает работу.
 *
 * Чего здесь нет намеренно: выдачи отчёта инвестору. Раскрытие идёт
 * существующими правилами видимости и уровнем раскрытия паспорта. ИИ-отчёт
 * сам по себе не означает ни одобрения проекта, ни допуска раунда.
 */
@Injectable()
export class ServiceExecutionService {
  private readonly logger = new Logger(ServiceExecutionService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly analysis: AnalysisService,
  ) {}

  /** Что можно запустить по покупке и что мешает — для экрана основателя. */
  async availability(ctx: RequestContext, purchaseId: string): Promise<ServiceRunAvailability[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const items = await this.executableItems(tx, purchaseId);
      const out: ServiceRunAvailability[] = [];
      for (const item of items) {
        const run = await this.latestRun(tx, item.id);
        out.push({
          itemId: item.id,
          canStart: run === null && item.purchase_status === 'paid',
          blocker: await this.startBlocker(tx, item, run),
          run,
        });
      }
      return out;
    });
  }

  async forPurchase(ctx: RequestContext, purchaseId: string): Promise<ServiceRunView[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM billing.purchase_item_runs WHERE purchase_id = $1
          ORDER BY started_at DESC`,
        [purchaseId],
      );
      const out: ServiceRunView[] = [];
      for (const row of rows) {
        const view = await this.view(tx, row.id);
        if (view) out.push(view);
      }
      return out;
    });
  }

  /**
   * Запустить разбор по конкретной позиции покупки.
   *
   * Порядок проверок обратный удобству и прямой по смыслу: сперва право и
   * оплата, потом — есть ли чем выполнять, и только затем запись о прогоне.
   * Иначе в журнале появлялись бы «запущенные» прогоны, которым нечем было
   * работать с самого начала.
   */
  async start(ctx: RequestContext, itemId: string): Promise<ServiceRunView> {
    const prepared = await this.db.transaction(ctx, async (tx) => {
      const item = await this.loadItem(tx, itemId);

      const existing = await this.latestRun(tx, itemId);
      if (existing && (existing.status === 'succeeded' || existing.status === 'running')) {
        // Повторное нажатие не создаёт второго исполнения: разбор уже идёт
        // либо уже сделан.
        return {
          run: existing,
          runId: null,
          projectId: item.project_id,
          // Разбор успешен, а позиция почему-то не закрыта — доведём до конца
          // вместо того, чтобы оставить оплаченную услугу в подвешенном виде.
          repair:
            existing.status === 'succeeded' && item.fulfillment_status !== 'fulfilled'
              ? { runId: existing.id, isLlm: existing.engine === 'llm' }
              : null,
        };
      }

      const blocker = await this.startBlocker(tx, item, existing);
      if (blocker !== null) throw errors.stateTransition(blocker);

      const version = await this.currentVersion(tx, item.project_id);
      const runId = uuidv7();
      await tx.query(
        `INSERT INTO billing.purchase_item_runs
           (id, item_id, purchase_id, project_id, kind, status, input_version_id,
            input_snapshot, requested_by)
         VALUES ($1, $2, $3, $4, 'ai_analysis', 'running', $5, $6::jsonb, $7)`,
        [
          runId,
          itemId,
          item.purchase_id,
          item.project_id,
          version?.id ?? null,
          JSON.stringify({
            versionNo: version?.version_no ?? null,
            projectUpdatedAt: version?.project_updated_at ?? null,
          }),
          ctx.userId,
        ],
      );

      await this.audit.emit(tx, {
        verb: 'billing.service_run.started',
        actorId: ctx.userId,
        actorRole: ctx.roles?.includes('admin') ? 'admin' : 'founder',
        subjectType: 'purchase_item_run',
        subjectId: runId,
        context: { itemId, purchaseId: item.purchase_id, serviceCode: item.service_code },
        traceId: ctx.traceId,
      });

      return { run: null, runId, projectId: item.project_id, repair: null };
    });

    if (prepared.run) {
      if (prepared.repair) {
        await this.closeItem(ctx, prepared.repair.runId, prepared.repair.isLlm);
      }
      return prepared.run;
    }
    const runId = prepared.runId!;

    // Разбор идёт ВНЕ транзакции записи прогона: он ходит наружу (в шлюз) и
    // может длиться секунды. Держать на это время транзакцию с блокировками
    // покупки — верный способ поймать таймаут на ровном месте.
    // Неуспех РАЗБОРА и неуспех записи результата — разные вещи, и ловить их
    // одним catch нельзя: упавшая запись приводила к попытке пометить уже
    // успешный прогон неуспешным, а это запрещено (прогон не переигрывается).
    let result;
    try {
      result = await this.analysis.run(ctx, prepared.projectId);
    } catch (error) {
      return await this.finishFailed(ctx, runId, error);
    }
    return await this.finishSucceeded(ctx, runId, result);
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Что мешает запустить разбор.
   *
   * Причины разные по смыслу, поэтому и текст разный: основателю должно быть
   * понятно, ждать ему, платить или обращаться к платформе.
   */
  private async startBlocker(
    tx: Tx,
    item: ItemRow,
    run: ServiceRunView | null,
  ): Promise<string | null> {
    if (item.execution_kind !== 'ai_analysis') {
      return 'эту услугу выполняет сотрудник платформы, запускать нечего';
    }
    if (item.purchase_status !== 'paid') {
      return 'покупка ещё не оплачена: разбор запускается по оплаченной услуге';
    }
    if (run?.status === 'succeeded') {
      return 'разбор по этой услуге уже выполнен';
    }
    if (run?.status === 'running' || run?.status === 'queued') {
      return 'разбор уже идёт';
    }

    const missing = await this.aiContourBlocker(tx);
    if (missing !== null) return missing;
    return null;
  }

  /**
   * Готов ли контур ИИ выполнить разбор — и если нет, то ЧЕГО именно не
   * хватает.
   *
   * Общее «сервис недоступен» здесь бесполезно: не хватать может флага,
   * шлюза или ключа провайдера, и это три разных действия трёх разных людей.
   */
  private async aiContourBlocker(tx: Tx): Promise<string | null> {
    const { rows } = await tx.query<{ key: string; enabled: boolean }>(
      `SELECT key, enabled FROM audit.feature_flags
        WHERE key IN ('ai.scoring.enabled', 'ai.scoring.llm.enabled')`,
    );
    const flags = Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
    if (!flags['ai.scoring.enabled']) {
      return 'разбор заявок выключен настройкой платформы (ai.scoring.enabled)';
    }
    if (!this.analysis.gatewayConfigured()) {
      return 'AI-шлюз не настроен: разбор выполнять нечем';
    }
    if (flags['ai.scoring.llm.enabled']) {
      const { rows: credential } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM scoring.ai_provider_credentials WHERE is_active`,
      );
      if ((credential[0]?.n ?? 0) === 0) {
        return 'разбор с языковой моделью включён, но ключ провайдера не задан';
      }
    }
    return null;
  }

  private async finishSucceeded(
    ctx: RequestContext,
    runId: string,
    result: { runId: string; passportId: string; isLlm: boolean; inputSha256: string },
  ): Promise<ServiceRunView> {
    const view = await this.db.transaction(ctx, async (tx) => {
      // Отпечаток входа приходит вместе с результатом разбора. Читать его из
      // снимка прогона нельзя: снимок лежит в `audit.node_checkpoints`, и его
      // видит только администратор — у основателя запрос вернул бы пусто, и
      // успешный разбор выглядел бы неудавшимся.
      const inputSha256 = result.inputSha256;

      await tx.query(
        `UPDATE billing.purchase_item_runs
            SET status = 'succeeded', finished_at = now(), engine = $2,
                agent_run_id = $3, result_ref = $4, result_kind = 'passport',
                input_sha256 = $5
          WHERE id = $1`,
        [runId, result.isLlm ? 'llm' : 'heuristic', result.runId, result.passportId, inputSha256],
      );

      await this.audit.emit(tx, {
        verb: 'billing.service_run.finished',
        actorId: ctx.userId,
        actorRole: ctx.roles?.includes('admin') ? 'admin' : 'founder',
        subjectType: 'purchase_item_run',
        subjectId: runId,
        context: { status: 'succeeded', engine: result.isLlm ? 'llm' : 'heuristic' },
        traceId: ctx.traceId,
      });

      return (await this.view(tx, runId))!;
    });

    // Услуга закрывается ОТДЕЛЬНЫМ действием платформы: у команды проекта
    // права менять позицию покупки нет, и появиться оно не должно. Триггер
    // M111 при этом видит уже зафиксированный успешный прогон.
    try {
      await this.closeItem(ctx, runId, result.isLlm);
    } catch (error) {
      // Разбор сделан и сохранён — это главное, и неуспешным он от этого не
      // становится. Пока позиция не закрыта, раунд по ней не откроется
      // («услуги не выполнены»), а следующий запрос на запуск доведёт
      // закрытие до конца, не создавая второго исполнения.
      this.logger.error({
        msg: 'разбор выполнен, но позиция покупки не закрыта',
        runId,
        internal: (error as { message?: string })?.message ?? String(error),
      });
    }
    return view;
  }

  /**
   * Отметить позицию выполненной по успешному прогону.
   *
   * Идемпотентно: повторный вызов по уже закрытой позиции ничего не меняет.
   * Это и делает шаг восстановимым — если закрытие не прошло с первого раза,
   * следующий запрос на запуск разбора доведёт его до конца, не создавая
   * второго исполнения.
   */
  private async closeItem(ctx: RequestContext, runId: string, isLlm: boolean): Promise<void> {
    await this.db.asServiceRole('app_billing', { traceId: ctx.traceId }, async (tx) => {
      const { rows } = await tx.query<{ item_id: string }>(
        `SELECT item_id FROM billing.purchase_item_runs
          WHERE id = $1 AND status = 'succeeded' AND result_ref IS NOT NULL`,
        [runId],
      );
      if (!rows[0]) return;
      await tx.query(
        `UPDATE billing.round_purchase_items
            SET fulfillment_status = 'fulfilled',
                fulfillment_note = $2,
                fulfilled_at = now()
          WHERE id = $1 AND fulfillment_status <> 'fulfilled'`,
        [
          rows[0].item_id,
          `разбор выполнен платформой${isLlm ? ' с языковой моделью' : ' без языковой модели'}; отчёт сохранён`,
        ],
      );
    });
  }

  private async finishFailed(
    ctx: RequestContext,
    runId: string,
    error: unknown,
  ): Promise<ServiceRunView> {
    const message = describeFailure(error);
    // Наружу — короткая причина, в журнал — настоящая: без неё разбираться с
    // упавшим разбором придётся вслепую.
    this.logger.warn({
      msg: 'разбор услуги не выполнен',
      runId,
      shown: message,
      code: (error as { code?: string })?.code ?? null,
      internal: (error as { message?: string })?.message ?? String(error),
      details: (error as { internal?: unknown })?.internal ?? null,
      cause: (error as { cause?: { message?: string } })?.cause?.message ?? null,
    });
    return this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE billing.purchase_item_runs
            SET status = 'failed', finished_at = now(), error_message = $2
          WHERE id = $1`,
        [runId, message],
      );
      await this.audit.emit(tx, {
        verb: 'billing.service_run.finished',
        actorId: ctx.userId,
        actorRole: ctx.roles?.includes('admin') ? 'admin' : 'founder',
        subjectType: 'purchase_item_run',
        subjectId: runId,
        context: { status: 'failed', reason: message },
        traceId: ctx.traceId,
      });
      return (await this.view(tx, runId))!;
    });
  }

  private async executableItems(tx: Tx, purchaseId: string): Promise<ItemRow[]> {
    const { rows } = await tx.query<ItemRow>(
      `${ITEM_SELECT} WHERE i.purchase_id = $1 AND s.execution_kind = 'ai_analysis'
        ORDER BY i.title`,
      [purchaseId],
    );
    return rows;
  }

  private async loadItem(tx: Tx, itemId: string): Promise<ItemRow> {
    const { rows } = await tx.query<ItemRow>(`${ITEM_SELECT} WHERE i.id = $1`, [itemId]);
    if (!rows[0]) throw errors.notFound({ subject: 'round_purchase_item' });
    return rows[0];
  }

  private async currentVersion(tx: Tx, projectId: string): Promise<VersionRow | null> {
    const { rows } = await tx.query<VersionRow>(
      `SELECT v.id, v.version_no, p.updated_at::text AS project_updated_at
         FROM lab.project_versions v
         JOIN lab.projects p ON p.id = v.project_id
        WHERE v.project_id = $1
        ORDER BY v.version_no DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ?? null;
  }

  private async latestRun(tx: Tx, itemId: string): Promise<ServiceRunView | null> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM billing.purchase_item_runs WHERE item_id = $1
        ORDER BY started_at DESC LIMIT 1`,
      [itemId],
    );
    return rows[0] ? this.view(tx, rows[0].id) : null;
  }

  private async view(tx: Tx, runId: string): Promise<ServiceRunView | null> {
    const { rows } = await tx.query<RunRow>(
      `SELECT r.id, r.item_id, r.purchase_id, r.kind, r.status, r.engine, r.is_test,
              r.input_version_id, r.input_sha256, r.input_snapshot, r.result_ref,
              r.error_message, r.started_at, r.finished_at,
              p.updated_at::text AS project_updated_at
         FROM billing.purchase_item_runs r
         JOIN lab.projects p ON p.id = r.project_id
        WHERE r.id = $1`,
      [runId],
    );
    const row = rows[0];
    if (!row) return null;

    const versionNo = row.input_snapshot?.versionNo ?? null;
    const analysedAt = row.input_snapshot?.projectUpdatedAt ?? null;
    // Заявку правили после разбора? Сравнение по времени правки проекта: это
    // ровно то, что попадает в снимок анализа.
    const inputChangedSince =
      row.status === 'succeeded' && analysedAt !== null
        ? row.project_updated_at !== analysedAt
        : false;

    const explanation: string[] = [];
    switch (row.status) {
      case 'queued':
        explanation.push('Разбор поставлен в очередь.');
        break;
      case 'running':
        explanation.push('Разбор выполняется. Повторный запуск не нужен: он ничего не ускорит.');
        break;
      case 'succeeded':
        explanation.push(
          row.engine === 'llm'
            ? 'Разбор выполнен с языковой моделью.'
            : row.engine === 'heuristic'
              ? 'Разбор выполнен по правилам, без языковой модели.'
              : 'Тестовое исполнение: это не анализ.',
        );
        if (versionNo !== null) {
          explanation.push(`Отчёт относится к версии заявки №${versionNo}.`);
        }
        if (inputChangedSince) {
          explanation.push(
            'После разбора заявка изменилась — отчёт описывает прошлую версию. ' +
              'Чтобы получить отчёт по текущей, нужен новый разбор.',
          );
        }
        explanation.push('Отчёт не означает одобрения проекта и не открывает раунд.');
        break;
      case 'failed':
        explanation.push('Разбор не выполнен.', row.error_message ?? 'Причина не сохранена.');
        break;
    }

    return {
      id: row.id,
      itemId: row.item_id,
      purchaseId: row.purchase_id,
      kind: 'ai_analysis',
      status: row.status,
      engine: row.engine,
      isTest: row.is_test,
      inputVersionId: row.input_version_id,
      inputVersionNo: versionNo,
      inputSha256: row.input_sha256,
      inputChangedSince,
      resultRef: row.result_ref,
      errorMessage: row.error_message,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      explanation,
    };
  }
}

const ITEM_SELECT = `
  SELECT i.id, i.purchase_id, i.service_code, i.title,
         i.fulfillment_status,
         COALESCE(s.execution_kind, 'manual') AS execution_kind,
         pu.status AS purchase_status, pu.project_id
    FROM billing.round_purchase_items i
    JOIN billing.round_purchases pu ON pu.id = i.purchase_id
    LEFT JOIN billing.round_services s ON s.code = i.service_code`;

/**
 * Почему разбор не удался — словами, но без внутренностей.
 *
 * Текст видит основатель, поэтому сюда не должно попадать ни содержимое
 * ответа шлюза, ни стек: там может оказаться и заявка, и адреса контура.
 */
function describeFailure(error: unknown): string {
  const code = (error as { code?: string })?.code;
  switch (code) {
    case 'upstream_unavailable':
      return 'сервис разбора временно недоступен, попробуйте позже';
    case 'feature_disabled':
      return 'разбор выключен настройкой платформы';
    case 'rate_limited':
      return 'превышен дневной предел разборов, попробуйте завтра';
    case 'residency_violation':
      return 'разбор запрещён правилами обработки данных этой страны';
    default:
      return 'разбор завершился ошибкой; платформа уже знает о ней';
  }
}

interface ItemRow {
  id: string;
  purchase_id: string;
  service_code: string | null;
  title: string;
  fulfillment_status: string;
  execution_kind: string;
  purchase_status: string;
  project_id: string;
}

interface VersionRow {
  id: string;
  version_no: number;
  project_updated_at: string;
}

interface RunRow {
  id: string;
  item_id: string;
  purchase_id: string;
  kind: 'ai_analysis';
  status: ServiceRunView['status'];
  engine: ServiceRunView['engine'];
  is_test: boolean;
  input_version_id: string | null;
  input_sha256: string | null;
  input_snapshot: { versionNo?: number | null; projectUpdatedAt?: string | null } | null;
  result_ref: string | null;
  error_message: string | null;
  started_at: Date;
  finished_at: Date | null;
  project_updated_at: string;
}
