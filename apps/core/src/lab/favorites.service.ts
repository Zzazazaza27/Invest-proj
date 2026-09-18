import { Injectable } from '@nestjs/common';
import type { FavoriteProject } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Избранные проекты инвестора.
 *
 * Два свойства, ради которых сервис вообще существует, а не решается одним
 * INSERT в контроллере:
 *
 *  1. ЧТО МОЖНО ДОБАВИТЬ. Внешний ключ на `lab.projects` пропускает любой
 *     существующий проект, включая чужой черновик. Это оракул: успех и отказ
 *     различают существующий идентификатор от несуществующего. Поэтому перед
 *     добавлением проект проверяется по ПУБЛИЧНОМУ каталогу, и «нет в
 *     каталоге» отвечает так же, как «нет вовсе» — 404.
 *
 *  2. ЧТО ВИДНО В СПИСКЕ. Избранное хранит только пару «человек — проект».
 *     Карточки для списка читаются тем же публичным каталогом, под ролью
 *     `app_public_read`: закладка не должна открывать данные, которых инвестор
 *     без неё не видит, иначе «добавить в избранное» стало бы обходом
 *     подписки.
 *
 * Границу «своё/чужое» держит политика RLS, а не условие в запросе: SELECT
 * ниже не содержит фильтра по пользователю вовсе — и всё равно возвращает
 * только свои строки.
 */
@Injectable()
export class FavoritesService {
  constructor(private readonly db: Database) {}

  /**
   * Добавить в избранное.
   *
   * Идемпотентно: повторный вызов не ошибка и не второй ряд — пара
   * (пользователь, проект) является первичным ключом. Интерфейс переключает
   * отметку, и двойное нажатие не должно превращаться в отказ.
   */
  async add(ctx: RequestContext, projectId: string): Promise<void> {
    if (!ctx.userId) throw errors.unauthenticated();
    await this.assertInPublicCatalog(ctx, projectId);

    await this.db.transaction(ctx, async (tx) => {
      try {
        await tx.query(
          `INSERT INTO lab.project_favorites (user_id, project_id)
                VALUES ($1, $2)
           ON CONFLICT (user_id, project_id) DO NOTHING`,
          [ctx.userId, projectId],
        );
      } catch (error) {
        // 42501 — политика не пустила: роли инвестора нет. Наружу это отказ в
        // праве, а не внутренняя ошибка.
        if ((error as { code?: string }).code === '42501') throw errors.forbidden({ projectId });
        throw error;
      }
    });
  }

  /**
   * Убрать из избранного.
   *
   * Ноль удалённых строк — не ошибка: отметки уже нет, а именно этого человек
   * и добивался. Отказ здесь означал бы, что повторное нажатие ломает
   * интерфейс.
   */
  async remove(ctx: RequestContext, projectId: string): Promise<void> {
    if (!ctx.userId) throw errors.unauthenticated();
    await this.db.transaction(ctx, async (tx) => {
      await tx.query(`DELETE FROM lab.project_favorites WHERE project_id = $1`, [projectId]);
    });
  }

  /** Идентификаторы избранного — для отметок на карточках каталога. */
  async listIds(ctx: RequestContext): Promise<string[]> {
    if (!ctx.userId) throw errors.unauthenticated();
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ project_id: string }>(
        // Фильтра по пользователю здесь нет намеренно: его ставит политика.
        // Условие в запросе выглядело бы защитой, но защитой не является —
        // прямой доступ к БД мимо этого кода оно не покрывает.
        `SELECT project_id FROM lab.project_favorites ORDER BY created_at DESC`,
      );
      return rows.map((row) => row.project_id);
    });
  }

  /** Список избранного карточками. */
  async list(ctx: RequestContext): Promise<FavoriteProject[]> {
    if (!ctx.userId) throw errors.unauthenticated();

    const marks = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ project_id: string; created_at: Date }>(
        `SELECT project_id, created_at FROM lab.project_favorites ORDER BY created_at DESC`,
      );
      return rows;
    });
    if (marks.length === 0) return [];

    const ids = marks.map((mark) => mark.project_id);
    // Тизеры — публичной ролью, но с сессией инвестора: проекция раунда (M085)
    // отдаёт поля по аудитории зрителя, а не всегда анонимную.
    const teasers = await this.db.asPublicRole(
      ctx.traceId,
      async (tx) => {
        const { rows } = await tx.query<TeaserRow>(
          `SELECT id, taxonomy_id, title, tagline, stage, geo_country, listed_at,
                  raising, round_target::text AS round_target, round_currency
             FROM lab.v_public_catalog
            WHERE id = ANY($1::uuid[])`,
          [ids],
        );
        return rows;
      },
      { userId: ctx.userId, roles: ctx.roles },
    );

    const byId = new Map(teasers.map((row) => [row.id, row]));
    // Порядок задают отметки, а не выдача каталога: человек ждёт «сверху то,
    // что добавил последним». Проект, ушедший из публичного каталога (снят с
    // листинга), просто не показывается — отметка при этом сохраняется, и
    // вернувшийся листинг снова появится в списке.
    return marks
      .map((mark) => {
        const row = byId.get(mark.project_id);
        if (!row) return null;
        return {
          id: row.id,
          title: row.title,
          tagline: row.tagline,
          stage: row.stage,
          taxonomyId: row.taxonomy_id,
          geoCountry: row.geo_country,
          investmentAsk: row.round_target,
          askCurrency: (row.round_currency?.trim() ?? 'RUB') as 'RUB',
          raising: row.raising,
          listedAt: row.listed_at ? row.listed_at.toISOString() : null,
          favoritedAt: mark.created_at.toISOString(),
        };
      })
      .filter((item): item is FavoriteProject => item !== null);
  }

  /**
   * Проект обязан быть в публичном каталоге.
   *
   * Читается под ролью `app_public_read` — той же, что отдаёт каталог. Иначе
   * проверка сказала бы «есть» про проект, который человеку не показывают.
   */
  private async assertInPublicCatalog(ctx: RequestContext, projectId: string): Promise<void> {
    // С сессией зрителя (M090): каталог — по предикату доступа, и проект,
    // открытый только допущенным инвесторам, добавляет только допущенный.
    const found = await this.db.asPublicRole(
      ctx.traceId,
      async (tx) => {
        const { rows } = await tx.query(`SELECT 1 FROM lab.v_public_catalog WHERE id = $1`, [
          projectId,
        ]);
        return rows.length > 0;
      },
      { userId: ctx.userId, roles: ctx.roles },
    );
    if (!found) throw errors.notFound({ subject: 'listing', projectId });
  }
}

interface TeaserRow {
  id: string;
  taxonomy_id: string | null;
  title: string;
  tagline: string | null;
  stage: FavoriteProject['stage'];
  geo_country: string | null;
  raising: 'open' | 'paused' | 'none' | 'undisclosed';
  round_target: string | null;
  round_currency: string | null;
  listed_at: Date | null;
}
