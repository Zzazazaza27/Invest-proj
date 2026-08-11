import { Injectable } from '@nestjs/common';
import {
  EventVerb,
  PROJECT_TRANSITIONS,
  SEASON_SELECTION_STAGES,
  SEASON_TRANSITIONS,
  SeasonFunnelConfigSchema,
  uuidv7,
  type AdvanceProjectStageRequest,
  type GoldenTicket,
  type ProjectStageChange,
  type ProjectStatus,
  type RatingEntry,
  type Season,
  type SeasonFunnelConfig,
  type SeasonStageOccupancy,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { NotificationsService } from '../comms/notifications.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Сезон — метроном воронки.
 *
 * Статусная машина односторонняя: сезон нельзя «вернуть» в приём заявок после
 * начала рецензирования. Эксперты уже работают по зафиксированному составу, и
 * дозаявка сломала бы сопоставимость оценок внутри сезона.
 *
 * Рейтинг сезона — материализованное представление поверх последних значений
 * IRS. Он пересчитывается явной командой организатора, а не при каждом чтении:
 * иначе публичная страница рейтинга становилась бы способом нагрузить БД
 * пересчётом по чужому запросу.
 */
@Injectable()
export class SeasonsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly notifications: NotificationsService,
  ) {}

  /** Текущий сезон: сначала открытый на приём, иначе ближайший активный. */
  async current(traceId: string): Promise<Season | null> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<SeasonRow>(
        `SELECT id, number, title, status, starts_at, ends_at
           FROM seasons.seasons
          WHERE status <> 'closed'
          ORDER BY CASE status WHEN 'applications_open' THEN 0 ELSE 1 END, number DESC
          LIMIT 1`,
      );
      return rows[0] ? mapSeason(rows[0]) : null;
    });
  }

  async changeStatus(
    ctx: RequestContext,
    seasonId: string,
    status: Season['status'],
  ): Promise<Season> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: found } = await tx.query<SeasonRow>(
        `SELECT id, number, title, status, starts_at, ends_at
           FROM seasons.seasons WHERE id = $1`,
        [seasonId],
      );
      const season = found[0];
      if (!season) throw errors.notFound({ subject: 'season' });
      if (season.status === status) return mapSeason(season);

      const allowed = SEASON_TRANSITIONS[season.status];
      if (!allowed.includes(status)) {
        throw errors.stateTransition(
          `Переход ${season.status} → ${status} не предусмотрен статусной машиной сезона`,
        );
      }

      const { rows } = await tx.query<SeasonRow>(
        `UPDATE seasons.seasons SET status = $2 WHERE id = $1
         RETURNING id, number, title, status, starts_at, ends_at`,
        [seasonId, status],
      );

      // Открытие и закрытие сезона — публичные факты: по ним синхронизируются
      // и потребители событий, и уведомления участникам.
      const verb =
        status === 'applications_open'
          ? 'lab.season.opened'
          : status === 'closed'
            ? 'lab.season.closed'
            : null;
      if (verb) {
        await this.audit.record(tx, {
          verb,
          actorId: ctx.userId,
          actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
          aggregateType: 'season',
          aggregateId: seasonId,
          aggregateVersion: season.number,
          payload: { seasonId, status },
          traceId: ctx.traceId,
        });
      }

      return mapSeason(rows[0]!);
    });
  }

  // ----------------------------------------------------------------- рейтинг

  /**
   * Рейтинг сезона. Публичен намеренно: смысл сезонного рейтинга в том, что его
   * видно снаружи. Роль `app_public_read` имеет права только на само
   * представление — ни черновиков, ни закрытых проектов через неё не достать.
   */
  async rating(traceId: string, seasonId: string, limit: number): Promise<RatingEntry[]> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<RatingRow>(
        `SELECT rank, project_id, title, irs, computed_at
           FROM seasons.mv_season_rating
          WHERE season_id = $1
          ORDER BY rank ASC
          LIMIT $2`,
        [seasonId, limit],
      );
      return rows.map(mapRating);
    });
  }

  /**
   * Пересчитать рейтинг.
   *
   * Обновление идёт через `seasons.refresh_rating()`: роль приложения не
   * владеет представлением и не должна им владеть, а функция проверяет роль
   * вызывающего у себя внутри. Событие публикуется только при фактическом
   * пересчёте — «рейтинг опубликован» без пересчёта было бы ложью в журнале.
   */
  async refreshRating(ctx: RequestContext, seasonId: string): Promise<{ refreshedAt: string }> {
    return this.db.transaction(ctx, async (tx) => {
      const season = await loadSeason(tx, seasonId);

      const { rows } = await tx.query<{ refreshed_at: Date }>(
        'SELECT seasons.refresh_rating() AS refreshed_at',
      );
      const refreshedAt = rows[0]!.refreshed_at;

      await this.audit.record(tx, {
        verb: EventVerb.RATING_PUBLISHED,
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
        aggregateType: 'season',
        aggregateId: seasonId,
        // Версия агрегата растёт с каждой публикацией рейтинга: номер сезона
        // здесь не годится — он один и тот же на все пересчёты.
        aggregateVersion: await nextRatingVersion(tx, seasonId),
        payload: { seasonId, seasonNumber: season.number },
        traceId: ctx.traceId,
      });

      return { refreshedAt: refreshedAt.toISOString() };
    });
  }

  // ---------------------------------------------------------- золотые билеты

  /**
   * Выдать золотой билет.
   *
   * Лимит на выдающего в пределах сезона держит триггер БД под advisory-локом:
   * проверка «сколько уже выдал» в приложении проигрывала бы гонке двух
   * одновременных запросов. Здесь только перевод отказа в понятный ответ.
   */
  async grantGoldenTicket(
    ctx: RequestContext,
    seasonId: string,
    input: { projectId: string; reason: string },
  ): Promise<GoldenTicket> {
    return this.db.transaction(ctx, async (tx) => {
      await loadSeason(tx, seasonId);
      const { rows: projectRows } = await tx.query<{ title: string }>(
        'SELECT title FROM lab.projects WHERE id = $1 AND deleted_at IS NULL',
        [input.projectId],
      );
      const project = projectRows[0];
      if (!project) throw errors.notFound({ subject: 'project' });

      let ticket: GoldenTicket;
      try {
        const { rows } = await tx.query<TicketRow>(
          `INSERT INTO seasons.golden_tickets (id, project_id, season_id, granted_by, reason)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, project_id, season_id, reason, used_at, created_at`,
          [uuidv7(), input.projectId, seasonId, ctx.userId, input.reason],
        );
        ticket = mapTicket(rows[0]!);
      } catch (error) {
        const pg = error as { code?: string; message?: string };
        if (pg.code === '23514' && (pg.message ?? '').includes('golden ticket limit')) {
          throw errors.limitExceeded('Лимит золотых билетов на этот сезон исчерпан');
        }
        if (pg.code === '23505') {
          throw errors.conflict('У проекта уже есть золотой билет в этом сезоне');
        }
        if (pg.code === '42501') throw errors.forbidden({ stage: 'db-policy' });
        throw error;
      }

      await this.audit.record(tx, {
        verb: EventVerb.GOLDEN_TICKET_GRANTED,
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
        aggregateType: 'golden_ticket',
        aggregateId: ticket.id,
        aggregateVersion: 1,
        payload: { projectId: input.projectId, seasonId, reason: input.reason },
        traceId: ctx.traceId,
      });

      const { rows: founders } = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM lab.founders_projects WHERE project_id = $1',
        [input.projectId],
      );
      for (const founder of founders) {
        await this.notifications.enqueue(tx, {
          userId: founder.user_id,
          code: 'season.golden_ticket.granted',
          payload: { project_title: project.title, project_id: input.projectId },
          dedupKey: `golden-ticket:${ticket.id}`,
        });
      }

      return ticket;
    });
  }

  // ------------------------------------------------- воронка и этапы сезона

  /**
   * Конфигурация воронки: квоты этапов и расписание их открытия.
   *
   * Хранится строкой сезона, а не константой в коде: буткемп на двенадцать
   * проектов и буткемп на три — это разные сезоны, а не разные сборки.
   */
  async setFunnelConfig(
    ctx: RequestContext,
    seasonId: string,
    config: SeasonFunnelConfig,
  ): Promise<SeasonFunnelConfig> {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE seasons.seasons SET funnel_config_jsonb = $2::jsonb WHERE id = $1`,
        [seasonId, JSON.stringify(config)],
      );
      if (rowCount === 0) throw errors.notFound({ subject: 'season' });

      await this.audit.record(tx, {
        verb: EventVerb.SEASON_FUNNEL_CONFIGURED,
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
        aggregateType: 'season',
        aggregateId: seasonId,
        aggregateVersion: await nextFunnelVersion(tx, seasonId),
        payload: { seasonId, funnelConfig: config },
        traceId: ctx.traceId,
      });
      return config;
    });
  }

  /** Занятость этапов: сколько проектов уже прошло и сколько мест осталось. */
  async funnelState(ctx: RequestContext, seasonId: string): Promise<SeasonStageOccupancy[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const config = await loadFunnelConfig(tx, seasonId);
      const { rows } = await tx.query<{ status: string; count: string }>(
        `SELECT status, count(*)::text AS count
           FROM lab.projects
          WHERE season_id = $1 AND deleted_at IS NULL
          GROUP BY status`,
        [seasonId],
      );
      const occupied = new Map(rows.map((row) => [row.status, Number(row.count)]));
      return SEASON_SELECTION_STAGES.map((stage) => ({
        stage,
        occupied: occupied.get(stage) ?? 0,
        quota: config.quotas[stage] ?? null,
        opensAt: config.schedule[stage] ?? null,
      }));
    });
  }

  /**
   * Перевести проект на следующий этап сезона.
   *
   * Три независимые проверки, и ни одна не заменяет другую:
   *  1. Переход допустим таблицей `PROJECT_TRANSITIONS` — шаг вперёд ровно на
   *     один этап (продублировано триггером БД: приложение может ошибиться).
   *  2. Этап открыт по расписанию сезона.
   *  3. На этапе есть место по квоте — либо у проекта есть непогашенный
   *     золотой билет, и он гасится ровно этим переводом.
   *
   * Квота считается ВНУТРИ транзакции под advisory-локом на пару
   * (сезон, этап): без него два одновременных перевода читают одно и то же
   * число занятых мест и оба проходят «последним».
   */
  async advanceProjectStage(
    ctx: RequestContext,
    seasonId: string,
    projectId: string,
    input: AdvanceProjectStageRequest,
  ): Promise<ProjectStageChange> {
    return this.db.transaction(ctx, async (tx) => {
      const season = await loadSeasonFull(tx, seasonId);
      if (season.status === 'closed') {
        throw errors.stateTransition('Сезон закрыт: переводы по этапам больше не выполняются');
      }

      const { rows: projectRows } = await tx.query<{
        id: string;
        title: string;
        status: ProjectStatus;
        season_id: string | null;
      }>(
        `SELECT id, title, status, season_id FROM lab.projects
          WHERE id = $1 AND deleted_at IS NULL`,
        [projectId],
      );
      const project = projectRows[0];
      if (!project) throw errors.notFound({ subject: 'project' });
      if (project.season_id !== seasonId) {
        throw errors.conflict('Проект не участвует в этом сезоне');
      }

      const allowed = PROJECT_TRANSITIONS[project.status];
      if (!allowed.includes(input.status)) {
        throw errors.stateTransition(
          `Переход ${project.status} → ${input.status} не предусмотрен воронкой проекта`,
        );
      }

      const config = await loadFunnelConfig(tx, seasonId);
      let redeemed = false;

      // Отказ не занимает мест и не ждёт расписания: это выход из воронки.
      if (input.status !== 'rejected') {
        const opensAt = config.schedule[input.status];
        if (opensAt && new Date(opensAt).getTime() > Date.now()) {
          throw errors.stateTransition(`Этап «${input.status}» открывается ${opensAt}`);
        }

        const quota = config.quotas[input.status];
        if (quota !== undefined) {
          await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `season-stage:${seasonId}:${input.status}`,
          ]);
          const { rows: countRows } = await tx.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM lab.projects
              WHERE season_id = $1 AND status = $2 AND deleted_at IS NULL`,
            [seasonId, input.status],
          );
          if (Number(countRows[0]!.count) >= quota) {
            if (!input.useGoldenTicket) {
              throw errors.limitExceeded(
                `Квота этапа «${input.status}» исчерпана (${quota}). Пройти можно по золотому билету`,
              );
            }
            redeemed = await this.redeemGoldenTicket(tx, ctx, seasonId, projectId);
            if (!redeemed) {
              throw errors.limitExceeded(
                `Квота этапа «${input.status}» исчерпана, а непогашенного золотого билета у проекта нет`,
              );
            }
          }
        }
      }

      const { rows: updated } = await tx.query<{ updated_at: Date }>(
        `UPDATE lab.projects SET status = $2, updated_at = now()
          WHERE id = $1 AND status = $3 AND deleted_at IS NULL
          RETURNING updated_at`,
        [projectId, input.status, project.status],
      );
      // Ноль строк здесь означает, что этап сменился между чтением и записью:
      // сообщать «переведено» в этом случае было бы ложью.
      if (updated.length === 0) throw errors.conflict('Этап проекта изменился параллельно');

      await this.audit.record(tx, {
        verb: EventVerb.PROJECT_STAGE_CHANGED,
        actorId: ctx.userId,
        actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
        aggregateType: 'project',
        aggregateId: projectId,
        aggregateVersion: await nextStageVersion(tx, projectId),
        payload: {
          seasonId,
          from: project.status,
          to: input.status,
          reason: input.reason,
          goldenTicketRedeemed: redeemed,
        },
        traceId: ctx.traceId,
      });

      const { rows: founders } = await tx.query<{ user_id: string }>(
        'SELECT user_id FROM lab.founders_projects WHERE project_id = $1',
        [projectId],
      );
      for (const founder of founders) {
        await this.notifications.enqueue(tx, {
          userId: founder.user_id,
          code: input.status === 'rejected' ? 'season.stage.rejected' : 'season.stage.advanced',
          payload: {
            project_title: project.title,
            stage_title: STAGE_TITLES[input.status] ?? input.status,
            season_number: String(season.number),
          },
          dedupKey: `stage:${projectId}:${input.status}`,
        });
      }

      return {
        projectId,
        from: project.status,
        to: input.status,
        goldenTicketRedeemed: redeemed,
        changedAt: updated[0]!.updated_at.toISOString(),
      };
    });
  }

  /**
   * Погасить золотой билет проекта. Возвращает false, если непогашенного билета
   * нет: это не ошибка сама по себе, решение принимает вызывающий.
   *
   * Погашение односторонне — обратный ход закрыт триггером БД (M025).
   */
  private async redeemGoldenTicket(
    tx: Tx,
    ctx: RequestContext,
    seasonId: string,
    projectId: string,
  ): Promise<boolean> {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE seasons.golden_tickets SET used_at = now()
        WHERE project_id = $1 AND season_id = $2 AND used_at IS NULL
        RETURNING id`,
      [projectId, seasonId],
    );
    const ticket = rows[0];
    if (!ticket) return false;

    await this.audit.record(tx, {
      verb: EventVerb.GOLDEN_TICKET_REDEEMED,
      actorId: ctx.userId,
      actorRole: ctx.roles.includes('admin') ? 'admin' : 'organizer',
      aggregateType: 'golden_ticket',
      aggregateId: ticket.id,
      // Версия 2: выдача была первой версией агрегата, погашение — вторая и
      // последняя. Третьей у билета быть не может.
      aggregateVersion: 2,
      payload: { projectId, seasonId },
      traceId: ctx.traceId,
    });
    return true;
  }

  async listGoldenTickets(ctx: RequestContext, seasonId: string): Promise<GoldenTicket[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<TicketRow>(
        `SELECT id, project_id, season_id, reason, used_at, created_at
           FROM seasons.golden_tickets
          WHERE season_id = $1
          ORDER BY created_at DESC
          LIMIT 200`,
        [seasonId],
      );
      return rows.map(mapTicket);
    });
  }
}

async function loadSeason(tx: Tx, seasonId: string): Promise<{ number: number }> {
  const { rows } = await tx.query<{ number: number }>(
    'SELECT number FROM seasons.seasons WHERE id = $1',
    [seasonId],
  );
  const season = rows[0];
  if (!season) throw errors.notFound({ subject: 'season' });
  return season;
}

async function loadSeasonFull(
  tx: Tx,
  seasonId: string,
): Promise<{ number: number; status: Season['status'] }> {
  const { rows } = await tx.query<{ number: number; status: Season['status'] }>(
    'SELECT number, status FROM seasons.seasons WHERE id = $1',
    [seasonId],
  );
  const season = rows[0];
  if (!season) throw errors.notFound({ subject: 'season' });
  return season;
}

/**
 * Конфигурация воронки из строки сезона.
 *
 * Разбор через схему, а не приведение типа: JSONB мог быть записан прошлой
 * версией приложения, и «доверять, потому что своё» — тот же класс ошибки, что
 * доверять телу запроса. Непрошедшее разбор считается пустой конфигурацией:
 * отсутствие квоты означает «без ограничения», и это безопасная сторона —
 * сломанная строка не должна закрывать сезон целиком.
 */
async function loadFunnelConfig(tx: Tx, seasonId: string): Promise<SeasonFunnelConfig> {
  const { rows } = await tx.query<{ funnel_config_jsonb: unknown }>(
    'SELECT funnel_config_jsonb FROM seasons.seasons WHERE id = $1',
    [seasonId],
  );
  if (rows.length === 0) throw errors.notFound({ subject: 'season' });
  const parsed = SeasonFunnelConfigSchema.safeParse(rows[0]!.funnel_config_jsonb ?? {});
  return parsed.success ? parsed.data : { quotas: {}, schedule: {} };
}

/** Человеческое название этапа для текста уведомления. */
const STAGE_TITLES: Partial<Record<ProjectStatus, string>> = {
  ai_review: 'AI-оценка',
  expert_review: 'экспертиза',
  bootcamp: 'буткемп',
  finalist: 'финал',
  graduated: 'выпуск',
  rejected: 'отказ',
};

/** Версия агрегата «проект» по числу уже записанных смен этапа. */
async function nextStageVersion(tx: Tx, projectId: string): Promise<number> {
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit.outbox_events
      WHERE aggregate_type = 'project' AND aggregate_id = $1 AND event_type = $2`,
    [projectId, EventVerb.PROJECT_STAGE_CHANGED],
  );
  return Number(rows[0]!.count) + 1;
}

/** Версия агрегата «сезон» по числу уже записанных правок воронки. */
async function nextFunnelVersion(tx: Tx, seasonId: string): Promise<number> {
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit.outbox_events
      WHERE aggregate_type = 'season' AND aggregate_id = $1 AND event_type = $2`,
    [seasonId, EventVerb.SEASON_FUNNEL_CONFIGURED],
  );
  return Number(rows[0]!.count) + 1;
}

/** Номер следующей публикации рейтинга сезона — по числу уже записанных. */
async function nextRatingVersion(tx: Tx, seasonId: string): Promise<number> {
  const { rows } = await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit.outbox_events
      WHERE aggregate_type = 'season' AND aggregate_id = $1 AND event_type = $2`,
    [seasonId, EventVerb.RATING_PUBLISHED],
  );
  return Number(rows[0]!.count) + 1;
}

interface RatingRow {
  rank: string;
  project_id: string;
  title: string;
  irs: string;
  computed_at: Date;
}

function mapRating(row: RatingRow): RatingEntry {
  return {
    // rank приходит из window-функции как BIGINT — драйвер отдаёт его строкой.
    rank: Number(row.rank),
    projectId: row.project_id,
    title: row.title,
    irs: Number(row.irs),
    computedAt: row.computed_at.toISOString(),
  };
}

interface TicketRow {
  id: string;
  project_id: string;
  season_id: string;
  reason: string;
  used_at: Date | null;
  created_at: Date;
}

function mapTicket(row: TicketRow): GoldenTicket {
  return {
    id: row.id,
    projectId: row.project_id,
    seasonId: row.season_id,
    reason: row.reason,
    usedAt: row.used_at ? row.used_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

interface SeasonRow {
  id: string;
  number: number;
  title: string | null;
  status: Season['status'];
  starts_at: Date;
  ends_at: Date;
}

function mapSeason(row: SeasonRow): Season {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
  };
}
