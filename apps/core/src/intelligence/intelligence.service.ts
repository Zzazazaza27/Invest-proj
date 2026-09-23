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
 * Market Intelligence — профильная база российского инвестиционного рынка.
 *
 * Постановки: docs/product/market-intelligence/ТЗ-MVP.md и ТЗ-перестройка.md.
 *
 *  * СУЩНОСТЬ — человек (всегда `person`), фонд, клуб, акселератор,
 *    мероприятие… «Инвестор», «спикер», «партнёр» — роли в фактах, а не типы.
 *  * ИСТОЧНИК — сайт или страница. Бывает ПРОФИЛЬНЫМ (площадка
 *    инвестиционного рынка) или нет (СМИ, блог). Пока не разобран — признак
 *    пуст. Собственный сайт сущности в её вес не идёт.
 *  * ФАКТ (таблица mentions) — когда, где, в какой роли, что произошло, с
 *    какой организацией и событием. В показатели идёт только ПОДТВЕРЖДЁННЫЙ:
 *    открыта конкретная страница, сущность на ней есть.
 *
 * Показатели (ТЗ-перестройка §11) — только по подтверждённым фактам, без
 * коэффициентов: сколько разных профильных площадок, сколько профильных
 * фактов, сколько медийных, когда впервые и в последний раз замечена на
 * профильной площадке.
 *
 * ПРАВИЛО ИМПОРТА: повторный импорт ничего, внесённого человеком, не
 * перетирает — дополняет пустые поля, обновляет сведения источника и
 * отметку проверки.
 */

export const ENTITY_TYPES = [
  'person',
  'organization',
  'fund',
  'investor_club',
  'accelerator',
  'venture_studio',
  'bootcamp',
  'event',
  'platform',
  'media',
  'corporation',
  'program',
  'project',
  'other',
] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_STATUSES = ['raw', 'reviewed', 'interesting', 'contacted', 'archived'] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

export const LEVELS = ['high', 'medium', 'low'] as const;
export const CONTACTS = ['yes', 'partial', 'no'] as const;
export const ALIVE = ['yes', 'no', 'unknown'] as const;
export const DISCOVERY = ['direct', 'reverse', 'import', 'manual'] as const;
export const PARSEABLE = ['yes', 'partial', 'no'] as const;
export const REVIEW = ['unchecked', 'checked', 'unreachable'] as const;
export const VERIFICATION = ['verified', 'candidate', 'rejected'] as const;
export const SOURCE_VERIFICATION = ['candidate', 'verified', 'rejected'] as const;
export const RELIABILITY = ['unassessed', 'reliable', 'doubtful'] as const;
/** Метка обхода краулером (M144): как часто и что снимать. */
export const CRAWL_MODES = ['off', 'daily', 'weekly'] as const;
export const CRAWL_EXTRACT = [
  'announcements',
  'jury',
  'speakers',
  'deals',
  'portfolio',
  'team',
  'calendar',
  'catalog',
] as const;
export const SOURCE_TYPES = [
  'fund',
  'investor_club',
  'accelerator',
  'venture_studio',
  'incubator',
  'bootcamp',
  'demo_day',
  'pitch_session',
  'conference',
  'competition',
  'investment_platform',
  'crowdinvesting',
  'investor_catalog',
  'startup_catalog',
  'community',
  'corporate_program',
  'bank_program',
  'university_program',
  'gov_program',
  'market_portal',
  'aggregator',
  'event_calendar',
  'media',
  'news',
  'blog',
  'telegram',
  'general',
  'speaker_agency',
  'education',
  'own_site',
  'other',
] as const;

export type Precision = 'day' | 'month' | 'year';

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
  isProfile: boolean | null;
  sourceType: (typeof SOURCE_TYPES)[number] | null;
  hasEvents: boolean | null;
  hasParticipantLists: boolean | null;
  parseable: (typeof PARSEABLE)[number] | null;
  reviewStatus: (typeof REVIEW)[number];
  verification: (typeof SOURCE_VERIFICATION)[number];
  reliability: (typeof RELIABILITY)[number];
  crawlMode: (typeof CRAWL_MODES)[number];
  crawlExtract: (typeof CRAWL_EXTRACT)[number][];
  crawlRule: string | null;
}

/** Факт: что, когда, в какой роли, с кем. Статус проверки — человека. */
export interface FactInput {
  role: string | null;
  action?: string | null;
  happenedOn?: string | null;
  happenedPrecision?: Precision | null;
  organizationId?: string | null;
  eventId?: string | null;
  verification?: (typeof VERIFICATION)[number];
  evidence?: string | null;
  notes?: string | null;
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

interface MetricsRow {
  profile_sources: string;
  profile_facts: string;
  media_facts: string;
  verified_facts: string;
  candidate_facts: string;
  first_profile: Date | string | null;
  last_profile: Date | string | null;
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
  is_profile: boolean | null;
  source_type: SourceFields['sourceType'];
  has_events: boolean | null;
  has_participant_lists: boolean | null;
  parseable: SourceFields['parseable'];
  review_status: SourceFields['reviewStatus'];
  verification: SourceFields['verification'];
  reliability: SourceFields['reliability'];
  crawl_mode: SourceFields['crawlMode'];
  crawl_extract: SourceFields['crawlExtract'];
  crawl_rule: string | null;
  discovered_at: Date;
  last_checked_at: Date | null;
  updated_at: Date;
  notes: string | null;
}

type SourceRowExt = SourceRow & {
  fact_count?: string;
  verified_count?: string;
  entity_count?: string;
  via_entity_name?: string | null;
  represents_entity_name?: string | null;
};

interface FactRow {
  id: string;
  entity_id: string;
  source_id: string;
  page_url: string | null;
  role: string | null;
  action: string | null;
  notes: string | null;
  evidence: string | null;
  found_at: Date;
  last_checked_at: Date | null;
  happened_on: Date | string | null;
  happened_precision: Precision | null;
  organization_id: string | null;
  event_id: string | null;
  verification: (typeof VERIFICATION)[number];
  verified_at: Date | null;
}

type FactRowExt = FactRow & {
  source_name: string | null;
  source_url: string;
  source_domain: string | null;
  is_profile: boolean | null;
  source_type: string | null;
  own_source: boolean;
  organization_name: string | null;
  event_name: string | null;
  entity_name?: string;
  entity_type?: EntityType;
};

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

function metricsView(row: MetricsRow) {
  return {
    uniqueProfileSources: Number(row.profile_sources),
    profileFacts: Number(row.profile_facts),
    mediaFacts: Number(row.media_facts),
    verifiedFacts: Number(row.verified_facts),
    candidateFacts: Number(row.candidate_facts),
    firstProfileOn: dateOnly(row.first_profile),
    lastProfileOn: dateOnly(row.last_profile),
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
    isProfile: row.is_profile,
    sourceType: row.source_type,
    hasEvents: row.has_events,
    hasParticipantLists: row.has_participant_lists,
    parseable: row.parseable,
    reviewStatus: row.review_status,
    verification: row.verification,
    reliability: row.reliability,
    crawlMode: row.crawl_mode,
    crawlExtract: row.crawl_extract,
    crawlRule: row.crawl_rule,
    factCount: Number(row.fact_count ?? 0),
    verifiedCount: Number(row.verified_count ?? 0),
    entityCount: Number(row.entity_count ?? 0),
    discoveredAt: row.discovered_at.toISOString(),
    lastCheckedAt: iso(row.last_checked_at),
    updatedAt: row.updated_at.toISOString(),
    notes: row.notes,
  };
}

function factView(row: FactRowExt) {
  return {
    id: row.id,
    entityId: row.entity_id,
    entityName: row.entity_name ?? null,
    entityType: row.entity_type ?? null,
    sourceId: row.source_id,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceDomain: row.source_domain,
    isProfileSource: row.is_profile,
    sourceType: row.source_type,
    ownSource: row.own_source,
    pageUrl: row.page_url,
    role: row.role,
    action: row.action,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    eventId: row.event_id,
    eventName: row.event_name,
    happenedOn: dateOnly(row.happened_on),
    happenedPrecision: row.happened_precision,
    verification: row.verification,
    verifiedAt: iso(row.verified_at),
    evidence: row.evidence,
    notes: row.notes,
    foundAt: row.found_at.toISOString(),
    lastCheckedAt: iso(row.last_checked_at),
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

/**
 * Площадка, которая добавляет вес (решение владельца 2026-09-23): профильная,
 * ПОДТВЕРЖДЁННАЯ (открыта и классифицирована) и не помеченная сомнительной.
 * Собственный сайт сущности не в счёт. Сомнительная площадка хранит факты —
 * они видны в хронике, — но веса не добавляет.
 */
const WEIGHTED_SOURCE = `s.is_profile AND s.verification = 'verified'
                  AND s.reliability <> 'doubtful'
                  AND s.represents_entity_id IS DISTINCT FROM e.id`;

/**
 * Показатели сущности `e` (ТЗ-перестройка §6, §11). Только подтверждённые
 * факты. «Профильные» — на площадках WEIGHTED_SOURCE; «медийные» — на
 * источниках, которые РАЗОБРАНЫ как непрофильные (неразобранные, не
 * открывшиеся и сомнительные не причисляются никуда).
 */
const METRICS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      count(DISTINCT coalesce(s.source_domain, s.id::text))
        FILTER (WHERE m.verification = 'verified' AND ${WEIGHTED_SOURCE}) AS profile_sources,
      count(*) FILTER (WHERE m.verification = 'verified' AND ${WEIGHTED_SOURCE}) AS profile_facts,
      count(*) FILTER (WHERE m.verification = 'verified' AND s.is_profile = false
                         AND s.verification = 'verified'
                         AND s.represents_entity_id IS DISTINCT FROM e.id
                         AND s.source_type IS DISTINCT FROM 'own_site') AS media_facts,
      count(*) FILTER (WHERE m.verification = 'verified') AS verified_facts,
      count(*) FILTER (WHERE m.verification = 'candidate') AS candidate_facts,
      min(coalesce(m.happened_on, m.found_at::date))
        FILTER (WHERE m.verification = 'verified' AND ${WEIGHTED_SOURCE}) AS first_profile,
      max(coalesce(m.happened_on, m.found_at::date))
        FILTER (WHERE m.verification = 'verified' AND ${WEIGHTED_SOURCE}) AS last_profile
      FROM intelligence.mentions m
      JOIN intelligence.sources s ON s.id = m.source_id
     WHERE m.entity_id = e.id
  ) x ON true`;

/** Факт со всем, что нужно показать: источник, организация, событие. */
const FACT_SELECT = `
  SELECT m.*,
         s.name AS source_name, s.source_url, s.source_domain, s.is_profile, s.source_type,
         (s.represents_entity_id = m.entity_id OR s.source_type = 'own_site') AS own_source,
         org.name AS organization_name,
         ev.name AS event_name,
         ent.name AS entity_name,
         ent.type AS entity_type
    FROM intelligence.mentions m
    JOIN intelligence.sources s ON s.id = m.source_id
    JOIN intelligence.entities ent ON ent.id = m.entity_id
    LEFT JOIN intelligence.entities org ON org.id = m.organization_id
    LEFT JOIN intelligence.entities ev ON ev.id = m.event_id`;

/** Источник со счётчиками фактов и именами связанных сущностей. */
const SOURCE_SELECT = `
  SELECT s.*,
         (SELECT count(*) FROM intelligence.mentions m WHERE m.source_id = s.id) AS fact_count,
         (SELECT count(*) FROM intelligence.mentions m
           WHERE m.source_id = s.id AND m.verification = 'verified') AS verified_count,
         (SELECT count(DISTINCT m.entity_id) FROM intelligence.mentions m
           WHERE m.source_id = s.id) AS entity_count,
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
  isProfile: 'is_profile',
  sourceType: 'source_type',
  hasEvents: 'has_events',
  hasParticipantLists: 'has_participant_lists',
  parseable: 'parseable',
  reviewStatus: 'review_status',
  verification: 'verification',
  reliability: 'reliability',
  crawlMode: 'crawl_mode',
  crawlExtract: 'crawl_extract',
  crawlRule: 'crawl_rule',
};

/**
 * Пост Telegram-канала (t.me/<канал>/<номер>) относится к площадке-каналу,
 * записанной адресом открытого превью t.me/s/<канал>; без этого факт уезжал
 * бы на общий источник t.me.
 */
function telegramPostAsPreview(url: string): string {
  const m = /^https?:\/\/t\.me\/(?!s\/)([A-Za-z0-9_]+)\/(\d+)/.exec(url);
  return m ? `https://t.me/s/${m[1]}/${m[2]}` : url;
}

@Injectable()
export class IntelligenceService {
  constructor(private readonly db: Database) {}

  // ============================================================ сущности

  async list(ctx: RequestContext, filter: { q: string; type?: string; status?: string }) {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<EntityRow & MetricsRow & { duplicate: boolean }>(
        // Признак дубля — оконным подсчётом по ВСЕЙ таблице: нормализованное
        // имя считается один раз на запись. Попарное сравнение (EXISTS с OR)
        // индексом не пользовалось и на тысяче записей занимало секунды.
        `WITH dup AS (
           SELECT id,
                  count(*) OVER (PARTITION BY type, intelligence.norm_name(name)) > 1
                  OR (external_url IS NOT NULL
                      AND count(*) OVER (PARTITION BY external_url) > 1) AS duplicate
             FROM intelligence.entities
         )
         SELECT e.*, x.*, dup.duplicate
           FROM intelligence.entities e
           JOIN dup ON dup.id = e.id
           ${METRICS_LATERAL}
          WHERE ($1 = '' OR e.name ILIKE '%' || $1 || '%'
                         OR e.organization_name ILIKE '%' || $1 || '%'
                         OR e.description ILIKE '%' || $1 || '%'
                         OR e.email ILIKE '%' || $1 || '%'
                         OR e.notes ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR e.type = $2)
            AND ($3::text IS NULL OR e.status = $3)
          ORDER BY e.updated_at DESC
          LIMIT 10000`,
        [likeEscape(filter.q), filter.type ?? null, filter.status ?? null],
      );
      return rows.map((row) => ({
        ...entityView(row),
        metrics: metricsView(row),
        duplicate: row.duplicate,
      }));
    });
  }

  async card(ctx: RequestContext, id: string) {
    return this.db.readOnly(ctx, (tx) => this.cardIn(tx, id));
  }

  private async cardIn(tx: Tx, id: string) {
    const { rows } = await tx.query<EntityRow & MetricsRow>(
      `SELECT e.*, x.* FROM intelligence.entities e ${METRICS_LATERAL} WHERE e.id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw errors.notFound({ entity: 'intelligence.entity', id });

    const facts = await tx.query<FactRowExt>(
      `${FACT_SELECT}
        WHERE m.entity_id = $1
        ORDER BY (m.verification = 'rejected'), m.happened_on DESC NULLS LAST, m.found_at DESC`,
      [id],
    );
    // Связи в обратную сторону: кто и что связано с этой организацией или
    // событием (партнёры фонда, спикеры Demo Day).
    const related = await tx.query<FactRowExt>(
      `${FACT_SELECT}
        WHERE (m.organization_id = $1 OR m.event_id = $1) AND m.entity_id <> $1
        ORDER BY m.happened_on DESC NULLS LAST, ent.name
        LIMIT 1000`,
      [id],
    );
    const own = await tx.query<SourceRowExt>(
      `${SOURCE_SELECT} WHERE s.represents_entity_id = $1 OR s.via_entity_id = $1
        ORDER BY s.discovered_at`,
      [id],
    );
    const duplicates = await this.duplicatesIn(tx, row, id);

    // Роли — из подтверждённых фактов: «Managing Partner — XYZ Ventures».
    const roles = new Map<
      string,
      {
        role: string;
        organizationId: string | null;
        organizationName: string | null;
        facts: number;
      }
    >();
    for (const f of facts.rows) {
      if (f.verification !== 'verified' || !f.role) continue;
      const key = `${f.role.toLowerCase()}|${f.organization_id ?? ''}`;
      const current = roles.get(key);
      if (current) current.facts += 1;
      else
        roles.set(key, {
          role: f.role,
          organizationId: f.organization_id,
          organizationName: f.organization_name,
          facts: 1,
        });
    }

    return {
      entity: entityView(row),
      metrics: metricsView(row),
      roles: [...roles.values()],
      facts: facts.rows.map(factView),
      related: related.rows.map(factView),
      ownSources: own.rows.map(sourceView),
      duplicates,
    };
  }

  private async duplicatesIn(
    tx: Tx,
    probe: { name: string; type: string; external_url: string | null },
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
            OR (type = $2 AND intelligence.norm_name(name) = intelligence.norm_name($1)))
        LIMIT 20`,
      [probe.name, probe.type, probe.external_url, exceptId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      organizationName: r.organization_name,
    }));
  }

  /** Сущности для выбора организации или события в форме факта. */
  async lookup(ctx: RequestContext, q: string) {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{ id: string; name: string; type: EntityType }>(
        `SELECT id, name, type FROM intelligence.entities
          WHERE name ILIKE '%' || $1 || '%'
          ORDER BY (lower(name) = lower($1)) DESC, length(name), name
          LIMIT 20`,
        [likeEscape(q)],
      );
      return rows;
    });
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
        // Адрес из формы добавления — кандидат: человек его указал, но
        // «открыта и проверена страница» — отдельное утверждение.
        await this.factByUrlIn(tx, ctx, id, { url: input.sourceUrl, role: null });
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

  /**
   * Объединить дубль `dropId` в `keepId` (ТЗ-перестройка §15, шаг 3).
   *
   * Факты, связи, источники и ключи импорта переезжают; пустые поля
   * оставляемой записи дополняются из дубля; сведения дубля сохраняются в
   * `attributes.merged` — ничего не теряется. Ключи импорта переезжают тоже,
   * иначе следующий импорт воскресил бы удалённый дубль.
   */
  async merge(ctx: RequestContext, keepId: string, dropId: string) {
    if (keepId === dropId) throw errors.conflict('Нельзя объединить запись саму с собой.');
    return this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<EntityRow>(
        'SELECT * FROM intelligence.entities WHERE id = ANY($1::uuid[]) FOR UPDATE',
        [[keepId, dropId]],
      );
      const keep = rows.find((r) => r.id === keepId);
      const drop = rows.find((r) => r.id === dropId);
      if (!keep || !drop) throw errors.notFound({ entity: 'intelligence.entity', keepId, dropId });

      // Факты дубля: копия на оставляемую запись; совпадающие схлопываются.
      await tx.query(
        `INSERT INTO intelligence.mentions
           (id, entity_id, source_id, page_url, role, action, notes, evidence, found_at,
            last_checked_at, happened_on, happened_precision, organization_id, event_id,
            verification, verified_at, created_by)
         SELECT gen_random_uuid(), $1, source_id, page_url, role, action, notes, evidence,
                found_at, last_checked_at, happened_on, happened_precision,
                CASE WHEN organization_id = $1 THEN NULL ELSE organization_id END,
                CASE WHEN event_id = $1 THEN NULL ELSE event_id END,
                verification, verified_at, created_by
           FROM intelligence.mentions WHERE entity_id = $2
         ON CONFLICT DO NOTHING`,
        [keepId, dropId],
      );
      // Ссылки на дубль как на организацию или событие.
      for (const column of ['organization_id', 'event_id']) {
        await tx.query(
          `UPDATE intelligence.mentions m SET ${column} = $1
            WHERE m.${column} = $2 AND m.entity_id <> $1
              AND NOT EXISTS (
                SELECT 1 FROM intelligence.mentions o
                 WHERE o.entity_id = m.entity_id AND o.source_id = m.source_id
                   AND coalesce(o.page_url, '') = coalesce(m.page_url, '')
                   AND coalesce(o.role, '') = coalesce(m.role, '')
                   AND o.${column} = $1)`,
          [keepId, dropId],
        );
      }
      await tx.query(
        'UPDATE intelligence.sources SET via_entity_id = $1 WHERE via_entity_id = $2',
        [keepId, dropId],
      );
      await tx.query(
        'UPDATE intelligence.sources SET represents_entity_id = $1 WHERE represents_entity_id = $2',
        [keepId, dropId],
      );
      await tx.query('UPDATE intelligence.external_ids SET entity_id = $1 WHERE entity_id = $2', [
        keepId,
        dropId,
      ]);
      await tx.query(
        `UPDATE intelligence.entities k
            SET organization_name = coalesce(k.organization_name, d.organization_name),
                description = coalesce(k.description, d.description),
                website_url = coalesce(k.website_url, d.website_url),
                email = coalesce(k.email, d.email),
                telegram = coalesce(k.telegram, d.telegram),
                linkedin = coalesce(k.linkedin, d.linkedin),
                notes = CASE WHEN d.notes IS NULL THEN k.notes
                             WHEN k.notes IS NULL THEN d.notes
                             ELSE k.notes || E'\\n\\n' || d.notes END,
                attributes = k.attributes || jsonb_build_object(
                  'merged', coalesce(k.attributes->'merged', '[]'::jsonb) || jsonb_build_array(
                    jsonb_build_object('id', d.id, 'name', d.name, 'type', d.type,
                                       'mergedAt', now(), 'attributes', d.attributes))),
                updated_at = now()
           FROM intelligence.entities d
          WHERE k.id = $1 AND d.id = $2`,
        [keepId, dropId],
      );
      await tx.query('DELETE FROM intelligence.entities WHERE id = $1', [dropId]);
      return this.cardIn(tx, keepId);
    });
  }

  // =============================================================== факты

  /** Факт по адресу страницы: источник находится по домену или заводится. */
  async addFact(ctx: RequestContext, entityId: string, input: FactInput & { url: string }) {
    return this.db.transaction(ctx, async (tx) => {
      await this.assertEntityIn(tx, entityId);
      await this.factByUrlIn(tx, ctx, entityId, input);
      await tx.query('UPDATE intelligence.entities SET updated_at = now() WHERE id = $1', [
        entityId,
      ]);
      return this.cardIn(tx, entityId);
    });
  }

  async updateFact(ctx: RequestContext, factId: string, patch: FactInput) {
    return this.db.transaction(ctx, async (tx) => {
      const precision = patch.happenedOn ? (patch.happenedPrecision ?? 'day') : null;
      const { rows } = await tx.query<{ entity_id: string }>(
        `UPDATE intelligence.mentions
            SET role = $2, action = $3, happened_on = $4, happened_precision = $5,
                organization_id = $6, event_id = $7,
                verification = coalesce($8, verification),
                verified_at = CASE WHEN $8 = 'verified' AND verification <> 'verified' THEN now()
                                   WHEN $8 IS NOT NULL AND $8 <> 'verified' THEN NULL
                                   ELSE verified_at END,
                evidence = $9, notes = $10
          WHERE id = $1
          RETURNING entity_id`,
        [
          factId,
          patch.role,
          patch.action ?? null,
          patch.happenedOn ?? null,
          precision,
          patch.organizationId ?? null,
          patch.eventId ?? null,
          patch.verification ?? null,
          patch.evidence ?? null,
          patch.notes ?? null,
        ],
      );
      if (!rows[0]) throw errors.notFound({ entity: 'intelligence.mention', id: factId });
      return this.cardIn(tx, rows[0].entity_id);
    });
  }

  async removeFact(ctx: RequestContext, factId: string) {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM intelligence.mentions WHERE id = $1', [
        factId,
      ]);
      if (!rowCount) throw errors.notFound({ entity: 'intelligence.mention', id: factId });
    });
  }

  private async assertEntityIn(tx: Tx, id: string) {
    const exists = await tx.query('SELECT 1 FROM intelligence.entities WHERE id = $1', [id]);
    if (!exists.rowCount) throw errors.notFound({ entity: 'intelligence.entity', id });
  }

  private async factByUrlIn(
    tx: Tx,
    ctx: RequestContext,
    entityId: string,
    input: FactInput & { url: string },
  ) {
    const sourceId = await this.resolveSourceIn(tx, ctx, input.url);
    await this.factIn(tx, ctx, { ...input, entityId, sourceId, pageUrl: input.url });
  }

  /**
   * Записать факт. Совпадающий (та же страница, роль, организация) не
   * дублируется: дополняются пустые поля, отметка проверки обновляется, а
   * статус может только ПОВЫСИТЬСЯ до подтверждённого — понизить его вправе
   * только человек.
   */
  private async factIn(
    tx: Tx,
    ctx: RequestContext,
    f: FactInput & { entityId: string; sourceId: string; pageUrl: string | null },
  ) {
    const precision = f.happenedOn ? (f.happenedPrecision ?? 'day') : null;
    const verification = f.verification ?? 'candidate';
    await tx.query(
      `INSERT INTO intelligence.mentions
         (id, entity_id, source_id, page_url, role, action, happened_on, happened_precision,
          organization_id, event_id, verification, verified_at, evidence, notes,
          last_checked_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
               CASE WHEN $11 = 'verified' THEN now() END, $12, $13, now(), $14)
       ON CONFLICT (entity_id, source_id, coalesce(page_url, ''), coalesce(role, ''),
                    coalesce(organization_id::text, ''))
       DO UPDATE SET last_checked_at = now(),
                     action = coalesce(intelligence.mentions.action, EXCLUDED.action),
                     evidence = coalesce(intelligence.mentions.evidence, EXCLUDED.evidence),
                     event_id = coalesce(intelligence.mentions.event_id, EXCLUDED.event_id),
                     happened_precision = CASE WHEN intelligence.mentions.happened_on IS NULL
                                               THEN EXCLUDED.happened_precision
                                               ELSE intelligence.mentions.happened_precision END,
                     happened_on = coalesce(intelligence.mentions.happened_on, EXCLUDED.happened_on),
                     verification = CASE WHEN EXCLUDED.verification = 'verified'
                                              AND intelligence.mentions.verification = 'candidate'
                                         THEN 'verified'
                                         ELSE intelligence.mentions.verification END,
                     verified_at = CASE WHEN EXCLUDED.verification = 'verified'
                                             AND intelligence.mentions.verification = 'candidate'
                                        THEN now()
                                        ELSE intelligence.mentions.verified_at END`,
      [
        randomUUID(),
        f.entityId,
        f.sourceId,
        f.pageUrl,
        f.role,
        f.action ?? null,
        f.happenedOn ?? null,
        precision,
        f.organizationId ?? null,
        f.eventId ?? null,
        verification,
        f.evidence ?? null,
        f.notes ?? null,
        ctx.userId,
      ],
    );
  }

  /**
   * Источник для адреса страницы: ровно этот адрес, иначе любой источник
   * того же домена (предпочитая корень), иначе — новый источник-сайт,
   * НЕРАЗОБРАННЫЙ: профильный он или нет, решает разбор, а не добавление.
   */
  private async resolveSourceIn(tx: Tx, ctx: RequestContext, pageUrl: string): Promise<string> {
    const url = telegramPostAsPreview(pageUrl);
    const domain = domainOf(url);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM intelligence.sources
        WHERE source_url = $1 OR ($2::text IS NOT NULL AND source_domain = $2)
        ORDER BY (source_url = $1) DESC,
               starts_with($1, source_url) DESC,
               CASE WHEN starts_with($1, source_url) THEN -length(source_url) ELSE length(source_url) END
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
        `${SOURCE_SELECT} ORDER BY s.updated_at DESC LIMIT 5000`,
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
    const facts = await tx.query<FactRowExt>(
      `${FACT_SELECT} WHERE m.source_id = $1 ORDER BY ent.name LIMIT 5000`,
      [id],
    );
    return { source: sourceView(rows[0]), facts: facts.rows.map(factView) };
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

  /** Источник удаляется только пустым: факты — это найденное, его жалко. */
  async removeSource(ctx: RequestContext, id: string) {
    return this.db.transaction(ctx, async (tx) => {
      const used = await tx.query('SELECT 1 FROM intelligence.mentions WHERE source_id = $1', [id]);
      if (used.rowCount) {
        throw errors.conflict('У источника есть факты — сначала уберите их.');
      }
      const { rowCount } = await tx.query('DELETE FROM intelligence.sources WHERE id = $1', [id]);
      if (!rowCount) throw errors.notFound({ entity: 'intelligence.source', id });
    });
  }

  /**
   * Новый источник по адресу: адрес сохраняется В ЛЮБОМ СЛУЧАЕ, заголовок —
   * если страницу удалось получить. Сущности из произвольной страницы не
   * извлекаются — это работа разбора.
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
            represents_entity_id, last_checked_at, notes, created_by, is_profile, source_type,
            has_events, has_participant_lists, parseable, review_status, verification,
            reliability)
         VALUES ($1, $2, $3, $4, coalesce($5, $4, $3), $6, $7, $8, $9, $10,
                 coalesce($11, CASE WHEN $16::timestamptz IS NULL THEN NULL ELSE 'yes' END),
                 $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
                 coalesce($24, 'unchecked'), coalesce($25, 'candidate'),
                 coalesce($26, 'unassessed'))
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
          input.isProfile ?? null,
          input.sourceType ?? null,
          input.hasEvents ?? null,
          input.hasParticipantLists ?? null,
          input.parseable ?? null,
          input.reviewStatus ?? null,
          input.verification ?? null,
          input.reliability ?? null,
        ],
      );
      const card = await this.sourceCardIn(tx, rows[0]!.id);
      return { ...card, fetched: checkedAt !== null, problem: fetchNote };
    });
  }

  /**
   * Собственный сайт сущности (ТЗ-перестройка §12): источник данных о ней,
   * но НЕ независимое подтверждение присутствия на рынке — в её вес не идёт.
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
    return this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE intelligence.sources
            SET represents_entity_id = $2, updated_at = now(),
                source_type = coalesce(source_type, 'own_site')
          WHERE id = $1`,
        [created.source.id, entityId],
      );
      return this.cardIn(tx, entityId);
    });
  }

  // ================================================= импорт get-investor.ru

  /**
   * Каталоги get-investor.ru (ТЗ §9) — ОДИН профильный источник. Каждая
   * карточка — подтверждённый факт «сущность в каталоге» со ссылкой на свою
   * страницу: карточка получена, сущность на ней есть по построению.
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
                is_profile = coalesce(is_profile, true),
                source_type = coalesce(source_type, 'aggregator'),
                verification = 'verified',
                review_status = 'checked', last_checked_at = now(), updated_at = now()
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
    // По ключу, а не по колонке записи: после объединения дублей у одной
    // сущности может быть несколько номеров каталога.
    const { rows } = await tx.query<{ entity_id: string }>(
      `SELECT entity_id FROM intelligence.external_ids
        WHERE import_source = 'get-investor' AND external_id = $1`,
      [fields.externalId],
    );
    let entityId: string;
    let outcome: 'created' | 'updated';
    if (!rows[0]) {
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
      await tx.query(
        `INSERT INTO intelligence.external_ids (import_source, external_id, entity_id, external_url)
         VALUES ('get-investor', $1, $2, $3)`,
        [fields.externalId, entityId, fields.externalUrl],
      );
    } else {
      entityId = rows[0].entity_id;
      outcome = 'updated';
      // Только пустые поля: поправленное человеком импорт не перетирает.
      // `attributes` дополняются, а не заменяются: там же след объединений.
      await tx.query(
        `UPDATE intelligence.entities
            SET organization_name = coalesce(organization_name, $2),
                description = coalesce(description, $3),
                website_url = coalesce(website_url, $4),
                email = coalesce(email, $5),
                telegram = coalesce(telegram, $6),
                linkedin = coalesce(linkedin, $7),
                attributes = attributes || $8::jsonb,
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
        ],
      );
    }
    await this.factIn(tx, ctx, {
      entityId,
      sourceId,
      pageUrl: fields.externalUrl,
      role: CATALOG_ROLE[catalog.key] ?? 'в каталоге',
      verification: 'verified',
    });
    return outcome;
  }
}

/** Роль карточки каталога — та же, что проставила миграция M141. */
const CATALOG_ROLE: Record<string, string> = {
  'business-angels': 'бизнес-ангел (в каталоге)',
  'investment-funds': 'фонд в каталоге',
  'investor-clubs': 'клуб в каталоге',
  accelerators: 'акселератор в каталоге',
  'venture-studios': 'венчурная студия в каталоге',
  'events-calendar': 'мероприятие в календаре',
};
