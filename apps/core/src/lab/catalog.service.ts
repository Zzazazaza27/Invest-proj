import { Injectable } from '@nestjs/common';
import type { CatalogQuery, ProjectTeaser, TaxonomyNode } from '@unicorn/contracts';
import { errors } from '../common/errors';
import { Database } from '../db/unit-of-work';

/**
 * Публичный каталог листингов.
 *
 * Две вещи делают его безопасным по конструкции, а не по внимательности автора
 * запроса:
 *
 *  1. Он ходит в БД под ролью `app_public_read`, у которой GRANT выдан на
 *     перечисленные колонки тизера — и только на них. Ошибка в SQL не сможет
 *     вернуть описание или статус чужого черновика: прав нет.
 *  2. Сортировка и направление берутся из allowlist и подставляются как
 *     литералы кода, а не как значение из запроса. Пользовательские данные
 *     доходят до БД исключительно параметрами.
 *
 * Пагинация — keyset: `OFFSET` на растущем каталоге и деградирует по плану, и
 * показывает одни и те же карточки на разных страницах.
 */

interface CursorPayload {
  /** Значение сортируемого поля предыдущей строки. */
  v: string;
  /** Идентификатор предыдущей строки — тай-брейкер, гарантирующий строгий порядок. */
  id: string;
}

@Injectable()
export class CatalogService {
  constructor(private readonly db: Database) {}

  async taxonomy(traceId: string): Promise<TaxonomyNode[]> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        parent_id: string | null;
        slug: string;
        name_ru: string;
        name_en: string | null;
      }>(
        `SELECT id, parent_id, slug, name_ru, name_en
           FROM lab.project_taxonomy
          WHERE is_active
          ORDER BY name_ru`,
      );
      return rows.map((r) => ({
        id: r.id,
        parentId: r.parent_id,
        slug: r.slug,
        nameRu: r.name_ru,
        nameEn: r.name_en,
      }));
    });
  }

  async list(
    traceId: string,
    query: CatalogQuery,
  ): Promise<{ items: ProjectTeaser[]; nextCursor: string | null }> {
    if (query.sort === 'relevance' && !query.q) {
      throw errors.validation([
        { path: 'sort', message: 'сортировка по релевантности требует поискового запроса' },
      ]);
    }
    if (query.askMin && query.askMax && Number(query.askMin) > Number(query.askMax)) {
      throw errors.validation([{ path: 'askMin', message: 'нижняя граница больше верхней' }]);
    }

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const params: unknown[] = [];
    const where: string[] = ["listing_status = 'listed'", 'deleted_at IS NULL'];

    if (query.q) {
      params.push(query.q);
      where.push(`public_search_tsv @@ plainto_tsquery('russian', $${params.length})`);
    }
    if (query.taxonomyId) {
      params.push(query.taxonomyId);
      where.push(`taxonomy_id = $${params.length}`);
    }
    if (query.stage) {
      params.push(query.stage);
      where.push(`stage = $${params.length}`);
    }
    if (query.geoCountry) {
      params.push(query.geoCountry);
      where.push(`geo_country = $${params.length}`);
    }
    if (query.askMin) {
      params.push(query.askMin);
      where.push(`investment_ask >= $${params.length}::numeric`);
    }
    if (query.askMax) {
      params.push(query.askMax);
      where.push(`investment_ask <= $${params.length}::numeric`);
    }

    // Выражение сортировки — из фиксированной таблицы, а не из строки запроса.
    const order = ORDERINGS[query.sort];
    if (cursor) {
      params.push(cursor.v);
      const valueParam = `$${params.length}${order.cast}`;
      params.push(cursor.id);
      const idParam = `$${params.length}`;
      where.push(`(${order.expression}, id) ${order.comparator} (${valueParam}, ${idParam})`);
    }

    params.push(query.limit + 1);
    const limitParam = `$${params.length}`;

    const sql = `
      SELECT id, taxonomy_id, title, tagline, stage, geo_country,
             investment_ask::text AS investment_ask, ask_currency, listed_at,
             (${order.expression})::text AS sort_value
        FROM lab.projects
       WHERE ${where.join(' AND ')}
       ORDER BY ${order.expression} ${order.direction}, id ${order.direction}
       LIMIT ${limitParam}`;

    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<TeaserRow>(sql, params);
      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const last = page.at(-1);

      return {
        items: page.map(mapTeaser),
        nextCursor: hasMore && last ? encodeCursor({ v: last.sort_value, id: last.id }) : null,
      };
    });
  }

  async getTeaser(traceId: string, projectId: string): Promise<ProjectTeaser> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<TeaserRow>(
        `SELECT id, taxonomy_id, title, tagline, stage, geo_country,
                investment_ask::text AS investment_ask, ask_currency, listed_at,
                ''::text AS sort_value
           FROM lab.v_public_catalog
          WHERE id = $1`,
        [projectId],
      );
      const row = rows[0];
      if (!row) throw errors.notFound({ subject: 'listing' });
      return mapTeaser(row);
    });
  }
}

/**
 * Допустимые сортировки. Ключ приходит из zod-перечисления, поэтому обращение
 * к этой таблице не может дать `undefined`, а её значения — литералы кода.
 *
 * `relevance` считает ранг прямо в выражении: хранить его негде, а курсор по
 * рангу вместе с id даёт строгий порядок.
 */
const ORDERINGS: Record<
  CatalogQuery['sort'],
  { expression: string; direction: 'ASC' | 'DESC'; comparator: '<' | '>'; cast: string }
> = {
  listed_at_desc: {
    expression: 'listed_at',
    direction: 'DESC',
    comparator: '<',
    cast: '::timestamptz',
  },
  ask_asc: { expression: 'investment_ask', direction: 'ASC', comparator: '>', cast: '::numeric' },
  ask_desc: { expression: 'investment_ask', direction: 'DESC', comparator: '<', cast: '::numeric' },
  relevance: {
    expression: "ts_rank(public_search_tsv, plainto_tsquery('russian', $1))",
    direction: 'DESC',
    comparator: '<',
    cast: '::real',
  },
};

interface TeaserRow {
  id: string;
  taxonomy_id: string | null;
  title: string;
  tagline: string | null;
  stage: ProjectTeaser['stage'];
  geo_country: string | null;
  investment_ask: string;
  ask_currency: string;
  listed_at: Date | null;
  sort_value: string;
}

function mapTeaser(row: TeaserRow): ProjectTeaser {
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
  };
}

/**
 * Курсор непрозрачен, но не является секретом: он описывает позицию в
 * публичной выдаче. Подделка курсора не даёт доступа ни к чему сверх той же
 * публичной выдачи — фильтр по строкам обеспечивает RLS, а не курсор.
 */
export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  const value = parsed as Partial<CursorPayload>;
  if (typeof value?.v !== 'string' || typeof value?.id !== 'string') {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  // Значение курсора уходит в запрос параметром, но его форму всё равно
  // проверяем: мусор здесь означает либо баг клиента, либо попытку подбора.
  if (value.v.length > 64 || !/^[0-9a-f-]{36}$/i.test(value.id)) {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  return { v: value.v, id: value.id };
}
