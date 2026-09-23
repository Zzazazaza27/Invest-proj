import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { errors } from '../common/errors';
import {
  extractTitle,
  fetchTildaProducts,
  GET_INVESTOR_CATALOGS,
  mapGetInvestorProduct,
  safeFetchText,
  type GetInvestorCatalog,
} from './intelligence.fetch';

/**
 * Market Intelligence (M137, M139): сведения об участниках инвестиционного
 * рынка. Постановка — docs/product/market-intelligence/ТЗ-MVP.md.
 *
 * Три понятия:
 *  * СУЩНОСТЬ — участник рынка: человек, фонд, клуб, мероприятие;
 *  * ИСТОЧНИК — сайт или страница, где участники собраны (каталог, статья,
 *    список спикеров). Ценен сам по себе: это результат поиска по
 *    интернету, ещё до разбора;
 *  * УПОМИНАНИЕ — сущность найдена в источнике. Одна сущность бывает во
 *    многих источниках, и так они сводятся вместе.
 *
 * Сущность может сама быть источником (`representsEntityId`): сайт фонда с
 * портфелем, страница клуба с участниками. Обратный путь поиска (ТЗ §17,
 * путь 2) — `viaEntityId`: источник найден, когда искали вокруг сущности.
 *
 * ПРАВИЛО ИМПОРТА: повторный импорт ничего, внесённого человеком, не
 * перетирает. Он дополняет пустые поля, обновляет сведения источника
 * (`attributes`) и отметку проверки. Статус и заметки — только человека.
 */

export const ENTITY_TYPES = [
  'person',
  'investor',
  'organization',
  'fund',
  'investor_club',
  'accelerator',
  'bootcamp',
  'event',
  'media',
  'corporation',
  'other',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_STATUSES = ['raw', 'reviewed', 'interesting', 'contacted', 'archived'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const LEVELS = ['high', 'medium', 'low'] as const;
export const CONTACTS = ['yes', 'partial', 'no'] as const;
export const ALIVE = ['yes', 'no', 'unknown'] as const;
export const DISCOVERY = ['direct', 'reverse', 'import', 'manual'] as const;

export interface EntityFields {
  type: EntityType;
  name: string;
  organizationName: string | null;
  description: string | null;
  websiteUrl: string | null;
  email: string | null;
  telegram: string | null;
  linkedin: string | null;
  status: EntityStatus;
  notes: string | null;
}

export interface SourceFields {
  url: string;
  name: string | null;
  kind: string | null;
  description: string | null;
  obtainable: string | null;
  structure: (typeof LEVELS)[number] | null;
  publicContacts: (typeof CONTACTS)[number] | null;
  alive: (typeof ALIVE)[number] | null;
  parserPriority: (typeof LEVELS)[number] | null;
  discovery: (typeof DISCOVERY)[number];
  viaEntityId: string | null;
  representsEntityId: string | null;
  notes: string | null;
}

interface EntityRow {
  id: string;
  type: EntityType;
  name: string;
  organization_name: string | null;
  description: string | null;
  website_url: string | null;
  email: string | null;
  telegram: string | null;
  linkedin: string | null;
  status: EntityStatus;
  notes: string | null;
  attributes: Record<string, unknown>;
  import_source: string | null;
  external_url: string | null;
  external_id: string | null;
  imported_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SourceRow {
  id: string;
  source_url: string;
  source_domain: string | null;
  source_title: string | null;
  name: string | null;
  kind: string | null;
  description: string | null;
  obtainable: string | null;
  structure: SourceFields['structure'];
  public_contacts: SourceFields['publicContacts'];
  alive: SourceFields['alive'];
  parser_priority: SourceFields['parserPriority'];
  discovery: SourceFields['discovery'];
  via_entity_id: string | null;
  represents_entity_id: string | null;
  discovered_at: Date;
  last_checked_at: Date | null;
  updated_at: Date;
  notes: string | null;
}

type SourceRowExt = SourceRow & {
  mention_count?: string;
  via_entity_name?: string | null;
  represents_entity_name?: string | null;
};

interface MentionRow {
  id: string;
  entity_id: string;
  source_id: string;
  page_url: string | null;
  context: string | null;
  notes: string | null;
  found_at: Date;
  last_checked_at: Date | null;
  happened_on: Date | string | null;
  happened_precision: Precision | null;
  summary: string | null;
}

export type Precision = 'day' | 'month' | 'year';

/** Хроника: что, когда. Поля человека, импорт их не перетирает. */
export interface MentionInput {
  context: string | null;
  summary?: string | null;
  happenedOn?: string | null;
  happenedPrecision?: Precision | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/**
 * DATE без часового пояса. Драйвер отдаёт его объектом Date на ЛОКАЛЬНУЮ
 * полночь; `toISOString` сдвинул бы день назад восточнее Гринвича.
 */
function dateOnly(value: Date | string | null): string | null {
  if (value === null || typeof value === 'string') return value;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function entityView(row: EntityRow) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    organizationName: row.organization_name,
    description: row.description,
    websiteUrl: row.website_url,
    email: row.email,
    telegram: row.telegram,
    linkedin: row.linkedin,
    status: row.status,
    notes: row.notes,
    attributes: row.attributes,
    importSource: row.import_source,
    externalUrl: row.external_url,
    externalId: row.external_id,
    importedAt: iso(row.imported_at),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function sourceView(row: SourceRowExt) {
  return {
    id: row.id,
    url: row.source_url,
    domain: row.source_domain,
    title: row.source_title,
    name: row.name,
    kind: row.kind,
    description: row.description,
    obtainable: row.obtainable,
    structure: row.structure,
    publicContacts: row.public_contacts,
    alive: row.alive,
    parserPriority: row.parser_priority,
    discovery: row.discovery,
    viaEntityId: row.via_entity_id,
    viaEntityName: row.via_entity_name ?? null,
    representsEntityId: row.represents_entity_id,
    representsEntityName: row.represents_entity_name ?? null,
    mentionCount: Number(row.mention_count ?? 0),
    discoveredAt: row.discovered_at.toISOString(),
    lastCheckedAt: iso(row.last_checked_at),
    updatedAt: row.updated_at.toISOString(),
    notes: row.notes,
  };
}

function mentionView(row: MentionRow) {
  return {
    id: row.id,
    entityId: row.entity_id,
    sourceId: row.source_id,
    pageUrl: row.page_url,
    context: row.context,
    notes: row.notes,
    foundAt: row.found_at.toISOString(),
    lastCheckedAt: iso(row.last_checked_at),
    happenedOn: dateOnly(row.happened_on),
    happenedPrecision: row.happened_precision,
    summary: row.summary,
  };
}

export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** `%` и `_` в строке поиска — буквы, а не шаблон. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Источник со счётчиком упоминаний и именами связанных сущностей. */
const SOURCE_SELECT = `
  SELECT s.*,
         (SELECT count(*) FROM intelligence.mentions m WHERE m.source_id = s.id) AS mention_count,
         via.name AS via_entity_name,
         rep.name AS represents_entity_name
    FROM intelligence.sources s
    LEFT JOIN intelligence.entities via ON via.id = s.via_entity_id
    LEFT JOIN intelligence.entities rep ON rep.id = s.represents_entity_id`;

const SOURCE_COLUMNS: Record<Exclude<keyof SourceFields, 'url'>, string> = {
  name: 'name',
  kind: 'kind',
  description: 'description',
  obtainable: 'obtainable',
  structure: 'structure',
  publicContacts: 'public_contacts',
  alive: 'alive',
  parserPriority: 'parser_priority',
  discovery: 'discovery',
  viaEntityId: 'via_entity_id',
  representsEntityId: 'represents_entity_id',
  notes: 'notes',
};

@Injectable()
export class IntelligenceService {
  constructor(private readonly db: Database) {}

  // ============================================================ сущности

  async list(ctx: RequestContext, filter: { q: string; type?: string; status?: string }) {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<
        EntityRow & { source_count: string; source_names: string | null; duplicate: boolean }
      >(
        `SELECT e.*,
                -- Вес сущности — число разных САЙТОВ, где она упомянута: две
                -- страницы одного сайта (rb.ru и rb.ru/data) — один голос.
                (SELECT count(DISTINCT coalesce(s.source_domain, s.id::text))
                   FROM intelligence.mentions m
                   JOIN intelligence.sources s ON s.id = m.source_id
                  WHERE m.entity_id = e.id) AS source_count,
                (SELECT string_agg(DISTINCT coalesce(s.name, s.source_domain), ', ')
                   FROM intelligence.mentions m
                   JOIN intelligence.sources s ON s.id = m.source_id
                  WHERE m.entity_id = e.id) AS source_names,
                EXISTS (
                  SELECT 1 FROM intelligence.entities d
                   WHERE d.id <> e.id
                     AND ((e.external_url IS NOT NULL AND d.external_url = e.external_url)
                       OR (lower(d.name) = lower(e.name)
                           AND lower(coalesce(d.organization_name, ''))
                             = lower(coalesce(e.organization_name, ''))))
                ) AS duplicate
           FROM intelligence.entities e
          WHERE ($1 = '' OR e.name ILIKE '%' || $1 || '%'
                         OR e.organization_name ILIKE '%' || $1 || '%'
                         OR e.description ILIKE '%' || $1 || '%'
                         OR e.email ILIKE '%' || $1 || '%'
                         OR e.notes ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR e.type = $2)
            AND ($3::text IS NULL OR e.status = $3)
          ORDER BY e.updated_at DESC
          LIMIT 5000`,
        [likeEscape(filter.q), filter.type ?? null, filter.status ?? null],
      );
      return rows.map((row) => ({
        ...entityView(row),
        sourceCount: Number(row.source_count),
        sourceNames: row.source_names,
        duplicate: row.duplicate,
      }));
    });
  }

  async card(ctx: RequestContext, id: string) {
    return this.db.readOnly(ctx, (tx) => this.cardIn(tx, id));
  }

  private async cardIn(tx: Tx, id: string) {
    const { rows } = await tx.query<EntityRow>(
      'SELECT * FROM intelligence.entities WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ entity: 'intelligence.entity', id });
    const mentions = await tx.query<MentionRow & SourceRowExt & { mention_id: string }>(
      `SELECT m.*, m.id AS mention_id, s.source_url, s.source_domain, s.name AS source_name
         FROM intelligence.mentions m
         JOIN intelligence.sources s ON s.id = m.source_id
        WHERE m.entity_id = $1
        ORDER BY m.happened_on DESC NULLS LAST, m.found_at DESC`,
      [id],
    );
    const own = await tx.query<SourceRowExt>(
      `${SOURCE_SELECT} WHERE s.represents_entity_id = $1 OR s.via_entity_id = $1
        ORDER BY s.discovered_at`,
      [id],
    );
    const duplicates = await this.duplicatesIn(tx, row, id);
    return {
      entity: entityView(row),
      mentions: mentions.rows.map((m) => ({
        ...mentionView({ ...m, id: m.mention_id }),
        sourceName: (m as unknown as { source_name: string | null }).source_name,
        sourceUrl: m.source_url,
        sourceDomain: m.source_domain,
      })),
      ownSources: own.rows.map(sourceView),
      duplicates,
    };
  }

  private async duplicatesIn(
    tx: Tx,
    probe: { name: string; organization_name: string | null; external_url: string | null },
    exceptId: string | null,
  ) {
    const { rows } = await tx.query<{
      id: string;
      name: string;
      type: string;
      organization_name: string | null;
    }>(
      `SELECT id, name, type, organization_name FROM intelligence.entities
        WHERE ($4::uuid IS NULL OR id <> $4)
          AND (($3::text IS NOT NULL AND external_url = $3)
            OR (lower(name) = lower($1)
                AND lower(coalesce(organization_name, '')) = lower(coalesce($2, ''))))
        LIMIT 20`,
      [probe.name, probe.organization_name, probe.external_url, exceptId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      organizationName: r.organization_name,
    }));
  }

  async create(ctx: RequestContext, input: EntityFields & { sourceUrl: string | null }) {
    return this.db.transaction(ctx, async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO intelligence.entities
           (id, type, name, organization_name, description, website_url, email,
            telegram, linkedin, status, notes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          id,
          input.type,
          input.name,
          input.organizationName,
          input.description,
          input.websiteUrl,
          input.email,
          input.telegram,
          input.linkedin,
          input.status,
          input.notes,
          ctx.userId,
        ],
      );
      if (input.sourceUrl) {
        await this.mentionByUrlIn(tx, ctx, id, { url: input.sourceUrl, context: null });
      }
      return this.cardIn(tx, id);
    });
  }

  async update(ctx: RequestContext, id: string, patch: Partial<EntityFields>) {
    const columns: Record<keyof EntityFields, string> = {
      type: 'type',
      name: 'name',
      organizationName: 'organization_name',
      description: 'description',
      websiteUrl: 'website_url',
      email: 'email',
      telegram: 'telegram',
      linkedin: 'linkedin',
      status: 'status',
      notes: 'notes',
    };
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns) as [keyof EntityFields, string][]) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    return this.db.transaction(ctx, async (tx) => {
      if (sets.length > 0) {
        const { rowCount } = await tx.query(
          `UPDATE intelligence.entities SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
          values,
        );
        if (!rowCount) throw errors.notFound({ entity: 'intelligence.entity', id });
      }
      return this.cardIn(tx, id);
    });
  }

  // ========================================================== упоминания

  /** «Найдено здесь»: адрес страницы → источник по домену → упоминание. */
  async addMention(ctx: RequestContext, entityId: string, input: MentionInput & { url: string }) {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertEntityIn(tx, entityId);
      await this.mentionByUrlIn(tx, ctx, entityId, input);
      await tx.query('UPDATE intelligence.entities SET updated_at = now() WHERE id = $1', [
        entityId,
      ]);
      return this.cardIn(tx, entityId);
    });
  }

  /** Правка строки хроники: роль, что делал, когда. */
  async updateMention(ctx: RequestContext, mentionId: string, patch: MentionInput) {
    return this.db.transaction(ctx, async (tx) => {
      const precision = patch.happenedOn ? (patch.happenedPrecision ?? 'day') : null;
      const { rows } = await tx.query<{ entity_id: string }>(
        `UPDATE intelligence.mentions
            SET context = $2, summary = $3, happened_on = $4, happened_precision = $5
          WHERE id = $1
          RETURNING entity_id`,
        [mentionId, patch.context, patch.summary ?? null, patch.happenedOn ?? null, precision],
      );
      if (!rows[0]) throw errors.notFound({ entity: 'intelligence.mention', id: mentionId });
      return this.cardIn(tx, rows[0].entity_id);
    });
  }

  async removeMention(ctx: RequestContext, mentionId: string) {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM intelligence.mentions WHERE id = $1', [
        mentionId,
      ]);
      if (!rowCount) throw errors.notFound({ entity: 'intelligence.mention', id: mentionId });
    });
  }

  private async assertEntityIn(tx: Tx, id: string) {
    const exists = await tx.query('SELECT 1 FROM intelligence.entities WHERE id = $1', [id]);
    if (!exists.rowCount) throw errors.notFound({ entity: 'intelligence.entity', id });
  }

  private async mentionByUrlIn(
    tx: Tx,
    ctx: RequestContext,
    entityId: string,
    input: MentionInput & { url: string },
  ) {
    const sourceId = await this.resolveSourceIn(tx, ctx, input.url);
    await this.mentionIn(tx, ctx, { ...input, entityId, sourceId, pageUrl: input.url });
  }

  private async mentionIn(
    tx: Tx,
    ctx: RequestContext,
    m: MentionInput & { entityId: string; sourceId: string; pageUrl: string | null },
  ) {
    const precision = m.happenedOn ? (m.happenedPrecision ?? 'day') : null;
    await tx.query(
      `INSERT INTO intelligence.mentions
         (id, entity_id, source_id, page_url, context, summary, happened_on,
          happened_precision, last_checked_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
       ON CONFLICT (entity_id, source_id, coalesce(page_url, ''))
       DO UPDATE SET last_checked_at = now(),
                     context = coalesce(intelligence.mentions.context, EXCLUDED.context),
                     summary = coalesce(intelligence.mentions.summary, EXCLUDED.summary),
                     happened_precision = CASE WHEN intelligence.mentions.happened_on IS NULL
                                               THEN EXCLUDED.happened_precision
                                               ELSE intelligence.mentions.happened_precision END,
                     happened_on = coalesce(intelligence.mentions.happened_on, EXCLUDED.happened_on)`,
      [
        randomUUID(),
        m.entityId,
        m.sourceId,
        m.pageUrl,
        m.context,
        m.summary ?? null,
        m.happenedOn ?? null,
        precision,
        ctx.userId,
      ],
    );
  }

  /**
   * Источник для адреса страницы.
   *
   * Сначала — источник ровно с этим адресом, затем — любой источник того же
   * домена (предпочитая корень сайта). Если нет ни того, ни другого,
   * заводится источник-сайт: страница — это упоминание, а не новый источник.
   */
  private async resolveSourceIn(tx: Tx, ctx: RequestContext, url: string): Promise<string> {
    const domain = domainOf(url);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM intelligence.sources
        WHERE source_url = $1 OR ($2::text IS NOT NULL AND source_domain = $2)
        ORDER BY (source_url = $1) DESC, length(source_url)
        LIMIT 1`,
      [url, domain],
    );
    if (rows[0]) return rows[0].id;
    const id = randomUUID();
    await tx.query(
      `INSERT INTO intelligence.sources
         (id, source_url, source_domain, name, discovery, created_by)
       VALUES ($1, $2, $3, $4, 'manual', $5)`,
      [id, domain ? `https://${domain}/` : url, domain, domain, ctx.userId],
    );
    return id;
  }

  // ============================================================ источники

  async sources(ctx: RequestContext) {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<SourceRowExt>(
        `${SOURCE_SELECT} ORDER BY s.updated_at DESC LIMIT 2000`,
      );
      return rows.map(sourceView);
    });
  }

  async sourceCard(ctx: RequestContext, id: string) {
    return this.db.readOnly(ctx, (tx) => this.sourceCardIn(tx, id));
  }

  private async sourceCardIn(tx: Tx, id: string) {
    const { rows } = await tx.query<SourceRowExt>(`${SOURCE_SELECT} WHERE s.id = $1`, [id]);
    if (!rows[0]) throw errors.notFound({ entity: 'intelligence.source', id });
    const mentions = await tx.query<
      MentionRow & { entity_name: string; entity_type: EntityType; mention_id: string }
    >(
      `SELECT m.*, m.id AS mention_id, e.name AS entity_name, e.type AS entity_type
         FROM intelligence.mentions m
         JOIN intelligence.entities e ON e.id = m.entity_id
        WHERE m.source_id = $1
        ORDER BY e.name
        LIMIT 2000`,
      [id],
    );
    return {
      source: sourceView(rows[0]),
      mentions: mentions.rows.map((m) => ({
        ...mentionView({ ...m, id: m.mention_id }),
        entityName: m.entity_name,
        entityType: m.entity_type,
      })),
    };
  }

  async updateSource(ctx: RequestContext, id: string, patch: Partial<SourceFields>) {
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(SOURCE_COLUMNS) as [
      keyof typeof SOURCE_COLUMNS,
      string,
    ][]) {
      if (patch[key] === undefined) continue;
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (patch.url !== undefined) {
      values.push(patch.url, domainOf(patch.url));
      sets.push(`source_url = $${values.length - 1}`, `source_domain = $${values.length}`);
    }
    return this.db.transaction(ctx, async (tx) => {
      if (sets.length > 0) {
        const { rowCount } = await tx.query(
          `UPDATE intelligence.sources SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`,
          values,
        );
        if (!rowCount) throw errors.notFound({ entity: 'intelligence.source', id });
      }
      return this.sourceCardIn(tx, id);
    });
  }

  /** Источник удаляется только пустым: упоминания — это найденное, его жалко. */
  async removeSource(ctx: RequestContext, id: string) {
    return this.db.transaction(ctx, async (tx) => {
      const used = await tx.query('SELECT 1 FROM intelligence.mentions WHERE source_id = $1', [id]);
      if (used.rowCount) {
        throw errors.conflict('У источника есть упоминания — сначала уберите их.');
      }
      const { rowCount } = await tx.query('DELETE FROM intelligence.sources WHERE id = $1', [id]);
      if (!rowCount) throw errors.notFound({ entity: 'intelligence.source', id });
    });
  }

  /**
   * «Импорт URL» (ТЗ §8) и ручное добавление источника: адрес сохраняется
   * В ЛЮБОМ СЛУЧАЕ, заголовок — если страницу удалось получить. Неудача
   * загрузки не отменяет находку.
   *
   * Сущности из произвольной страницы не извлекаются: универсального
   * разборщика ТЗ прямо не просит, а угадывание дало бы мусор.
   */
  async importUrl(ctx: RequestContext, input: Partial<SourceFields> & { url: string }) {
    let title: string | null = null;
    let fetchNote: string | null = null;
    let checkedAt: Date | null = null;
    try {
      title = extractTitle(await safeFetchText(input.url));
      checkedAt = new Date();
    } catch (error) {
      fetchNote = `Страница не получена: ${error instanceof Error ? error.message : String(error)}`;
    }

    return this.db.transaction(ctx, async (tx) => {
      for (const ref of [input.viaEntityId, input.representsEntityId]) {
        if (ref) await this.assertEntityIn(tx, ref);
      }
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO intelligence.sources
           (id, source_url, source_domain, source_title, name, kind, description, obtainable,
            structure, public_contacts, alive, parser_priority, discovery, via_entity_id,
            represents_entity_id, last_checked_at, notes, created_by)
         VALUES ($1, $2, $3, $4, coalesce($5, $4, $3), $6, $7, $8, $9, $10,
                 coalesce($11, CASE WHEN $16::timestamptz IS NULL THEN NULL ELSE 'yes' END),
                 $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (source_url) WHERE entity_id IS NULL
         DO UPDATE SET source_title = coalesce(EXCLUDED.source_title, intelligence.sources.source_title),
                       last_checked_at = coalesce(EXCLUDED.last_checked_at,
                                                  intelligence.sources.last_checked_at),
                       updated_at = now()
         RETURNING id`,
        [
          randomUUID(),
          input.url,
          domainOf(input.url),
          title,
          input.name ?? null,
          input.kind ?? null,
          input.description ?? null,
          input.obtainable ?? null,
          input.structure ?? null,
          input.publicContacts ?? null,
          input.alive ?? null,
          input.parserPriority ?? null,
          input.discovery ?? 'manual',
          input.viaEntityId ?? null,
          input.representsEntityId ?? null,
          checkedAt,
          [input.notes, fetchNote].filter(Boolean).join('\n') || null,
          ctx.userId,
        ],
      );
      const card = await this.sourceCardIn(tx, rows[0]!.id);
      return { ...card, fetched: checkedAt !== null, problem: fetchNote };
    });
  }

  /**
   * «Сущность сама источник»: сайт фонда, страница клуба или мероприятия.
   * Без адреса берётся сайт сущности.
   */
  async entityAsSource(ctx: RequestContext, entityId: string, url: string | null) {
    const target = await this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ website_url: string | null; name: string }>(
        'SELECT website_url, name FROM intelligence.entities WHERE id = $1',
        [entityId],
      );
      if (!rows[0]) throw errors.notFound({ entity: 'intelligence.entity', id: entityId });
      return rows[0];
    });
    const address = url ?? target.website_url;
    if (!address || !/^https?:\/\//i.test(address)) {
      throw errors.validation([
        { path: 'url', message: 'У сущности нет сайта — укажите адрес страницы' },
      ]);
    }
    const created = await this.importUrl(ctx, {
      url: address,
      name: target.name,
      discovery: 'manual',
    });
    // Источник мог существовать раньше (тот же адрес): привязка ставится
    // явно, а не только при создании.
    return this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE intelligence.sources SET represents_entity_id = $2, updated_at = now()
          WHERE id = $1`,
        [created.source.id, entityId],
      );
      return this.cardIn(tx, entityId);
    });
  }

  // ================================================= импорт get-investor.ru

  /**
   * Каталоги get-investor.ru (ТЗ §9) — ОДИН источник, в котором найдены
   * сотни сущностей. Каждая карточка каталога — упоминание со ссылкой на
   * свою страницу. Разбор карточек — `intelligence.fetch.ts`.
   */
  async importGetInvestor(ctx: RequestContext) {
    const report: {
      catalog: string;
      fetched: number;
      created: number;
      updated: number;
      error?: string;
    }[] = [];
    const sourceId = await this.db.transaction(ctx, async (tx) => {
      const id = await this.resolveSourceIn(tx, ctx, 'https://get-investor.ru/');
      await tx.query(
        `UPDATE intelligence.sources
            SET name = coalesce(name, 'Get-Investor'), discovery = 'import',
                last_checked_at = now(), updated_at = now()
          WHERE id = $1`,
        [id],
      );
      return id;
    });
    for (const catalog of GET_INVESTOR_CATALOGS) {
      let products: Awaited<ReturnType<typeof fetchTildaProducts>>;
      try {
        products = await fetchTildaProducts(catalog.storePart);
      } catch (error) {
        report.push({
          catalog: catalog.label,
          fetched: 0,
          created: 0,
          updated: 0,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      const counts = await this.db.transaction(ctx, async (tx) => {
        let created = 0;
        let updated = 0;
        for (const product of products) {
          const outcome = await this.upsertGetInvestorIn(tx, ctx, sourceId, catalog, product);
          if (outcome === 'created') created += 1;
          else updated += 1;
        }
        return { created, updated };
      });
      report.push({ catalog: catalog.label, fetched: products.length, ...counts });
    }
    return { report };
  }

  private async upsertGetInvestorIn(
    tx: Tx,
    ctx: RequestContext,
    sourceId: string,
    catalog: GetInvestorCatalog,
    product: Parameters<typeof mapGetInvestorProduct>[1],
  ): Promise<'created' | 'updated'> {
    const fields = mapGetInvestorProduct(catalog, product);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM intelligence.entities
        WHERE import_source = 'get-investor' AND external_id = $1`,
      [fields.externalId],
    );
    const existing = rows[0];
    let entityId: string;
    let outcome: 'created' | 'updated';
    if (!existing) {
      entityId = randomUUID();
      outcome = 'created';
      await tx.query(
        `INSERT INTO intelligence.entities
           (id, type, name, organization_name, description, website_url, email, telegram,
            linkedin, attributes, import_source, external_url, external_id, imported_at,
            created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'get-investor', $11, $12, now(), $13)`,
        [
          entityId,
          fields.type,
          fields.name,
          fields.organizationName,
          fields.description,
          fields.websiteUrl,
          fields.email,
          fields.telegram,
          fields.linkedin,
          JSON.stringify(fields.attributes),
          fields.externalUrl,
          fields.externalId,
          ctx.userId,
        ],
      );
    } else {
      entityId = existing.id;
      outcome = 'updated';
      // Только пустые поля: поправленное человеком импорт не перетирает.
      await tx.query(
        `UPDATE intelligence.entities
            SET organization_name = coalesce(organization_name, $2),
                description = coalesce(description, $3),
                website_url = coalesce(website_url, $4),
                email = coalesce(email, $5),
                telegram = coalesce(telegram, $6),
                linkedin = coalesce(linkedin, $7),
                attributes = $8,
                external_url = $9,
                imported_at = now()
          WHERE id = $1`,
        [
          entityId,
          fields.organizationName,
          fields.description,
          fields.websiteUrl,
          fields.email,
          fields.telegram,
          fields.linkedin,
          JSON.stringify(fields.attributes),
          fields.externalUrl,
        ],
      );
    }
    await this.mentionIn(tx, ctx, {
      entityId,
      sourceId,
      pageUrl: fields.externalUrl,
      context: catalog.label,
    });
    return outcome;
  }
}
