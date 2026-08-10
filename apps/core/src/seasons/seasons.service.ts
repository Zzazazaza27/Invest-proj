import { Injectable } from '@nestjs/common';
import { SEASON_TRANSITIONS, type Season } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Сезон — метроном воронки.
 *
 * В этой фазе от сезонов нужно ровно две вещи: знать текущий (иначе заявку
 * некуда подавать) и уметь открыть приём заявок. Рейтинги, буткемп и финал
 * появятся вместе с экспертизой; закладывать их сейчас — значит писать код,
 * который никто не сможет проверить прогоном.
 *
 * Статусная машина односторонняя: сезон нельзя «вернуть» в приём заявок после
 * начала рецензирования. Эксперты уже работают по зафиксированному составу, и
 * дозаявка сломала бы сопоставимость оценок внутри сезона.
 */
@Injectable()
export class SeasonsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
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
