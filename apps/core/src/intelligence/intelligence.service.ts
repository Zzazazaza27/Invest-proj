import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { errors } from '../common/errors';

/**
 * Market Intelligence (M137): сведения об участниках инвестиционного рынка.
 *
 * Постановка — docs/product/market-intelligence/ТЗ-MVP.md. Это склад, а не
 * CRM: ни связей, ни скоринга, ни воронки. Сначала данные, потом модель.
 *
 * Три пути наполнения:
 *  * вручную из админки;
 *  * «Импорт URL» — страница сохраняется как источник (адрес, заголовок,
 *    домен), разбор её остаётся человеку;
 *  * импорт каталогов get-investor.ru — первый специализированный разборщик.
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
  entity_id: string | null;
  source_url: string;
  source_domain: string | null;
  source_title: string | null;
  discovered_at: Date;
  last_checked_at: Date | null;
  notes: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

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

function sourceView(row: SourceRow & { entity_name?: string | null }) {
  return {
    id: row.id,
    entityId: row.entity_id,
    entityName: row.entity_name ?? null,
    url: row.source_url,
    domain: row.source_domain,
    title: row.source_title,
    discoveredAt: row.discovered_at.toISOString(),
    lastCheckedAt: iso(row.last_checked_at),
    notes: row.notes,
  };
}

function domainOf(url: string): string | null {
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

@Injectable()
export class IntelligenceService {
  constructor(private readonly db: Database) {}

  // ------------------------------------------------------------- чтение

  async list(ctx: RequestContext, filter: { q: string; type?: string; status?: string }) {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<
        EntityRow & { source_count: string; source_domains: string | null; duplicate: boolean }
      >(
        `SELECT e.*,
                (SELECT count(*) FROM intelligence.sources s WHERE s.entity_id = e.id) AS source_count,
                (SELECT string_agg(DISTINCT s.source_domain, ', ')
                   FROM intelligence.sources s WHERE s.entity_id = e.id) AS source_domains,
                EXISTS (
                  SELECT 1 FROM intelligence.entities d
                   WHERE d.id <> e.id
                     AND ((e.external_url IS NOT NULL AND d.external_url = e.external_url)
                       OR (lower(d.name) = lower(e.name)
                           AND lower(coalesce(d.organization_name, '')) = lower(coalesce(e.organization_name, ''))))
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
        sourceDomains: row.source_domains,
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
    const sources = await tx.query<SourceRow>(
      `SELECT * FROM intelligence.sources WHERE entity_id = $1 ORDER BY discovered_at`,
      [id],
    );
    const duplicates = await this.duplicatesIn(tx, row, id);
    return {
      entity: entityView(row),
      sources: sources.rows.map(sourceView),
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
            OR (lower(name) = lower($1) AND lower(coalesce(organization_name, '')) = lower(coalesce($2, ''))))
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

  async sources(ctx: RequestContext, onlyLoose: boolean) {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<SourceRow & { entity_name: string | null }>(
        `SELECT s.*, e.name AS entity_name
           FROM intelligence.sources s
           LEFT JOIN intelligence.entities e ON e.id = s.entity_id
          WHERE (NOT $1 OR s.entity_id IS NULL)
          ORDER BY s.discovered_at DESC
          LIMIT 1000`,
        [onlyLoose],
      );
      return rows.map(sourceView);
    });
  }

  // ------------------------------------------------------------- запись

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
        await this.attachSourceIn(tx, ctx, id, { url: input.sourceUrl, title: null, notes: null });
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

  async addSource(
    ctx: RequestContext,
    entityId: string,
    input: { url: string; title: string | null; notes: string | null },
  ) {
    return this.db.transaction(ctx, async (tx) => {
      const exists = await tx.query('SELECT 1 FROM intelligence.entities WHERE id = $1', [
        entityId,
      ]);
      if (!exists.rowCount) throw errors.notFound({ entity: 'intelligence.entity', id: entityId });
      await this.attachSourceIn(tx, ctx, entityId, input);
      await tx.query('UPDATE intelligence.entities SET updated_at = now() WHERE id = $1', [
        entityId,
      ]);
      return this.cardIn(tx, entityId);
    });
  }

  async removeSource(ctx: RequestContext, sourceId: string) {
    return this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query('DELETE FROM intelligence.sources WHERE id = $1', [
        sourceId,
      ]);
      if (!rowCount) throw errors.notFound({ entity: 'intelligence.source', id: sourceId });
    });
  }

  private async attachSourceIn(
    tx: Tx,
    ctx: RequestContext,
    entityId: string,
    input: { url: string; title: string | null; notes: string | null },
  ) {
    await tx.query(
      `INSERT INTO intelligence.sources
         (id, entity_id, source_url, source_domain, source_title, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (entity_id, source_url) WHERE entity_id IS NOT NULL
       DO UPDATE SET source_title = coalesce(EXCLUDED.source_title, intelligence.sources.source_title),
                     notes = coalesce(EXCLUDED.notes, intelligence.sources.notes)`,
      [
        randomUUID(),
        entityId,
        input.url,
        domainOf(input.url),
        input.title,
        input.notes,
        ctx.userId,
      ],
    );
  }

  // ------------------------------------------------------ импорт страницы

  /**
   * «Импорт URL» (ТЗ §8): адрес сохраняется В ЛЮБОМ СЛУЧАЕ, а заголовок —
   * если страницу удалось получить. Неудача загрузки не отменяет находку:
   * сайт мог быть недоступен минуту, а адрес уже ценен.
   *
   * Сущности из произвольной страницы не извлекаются: универсального
   * разборщика ТЗ прямо не просит, а угадывание дало бы мусор.
   */
  async importUrl(ctx: RequestContext, input: { url: string; entityId: string | null }) {
    let title: string | null = null;
    let fetchNote: string | null = null;
    let checkedAt: Date | null = null;
    try {
      const html = await safeFetchText(input.url);
      title = extractTitle(html);
      checkedAt = new Date();
    } catch (error) {
      fetchNote = `Страница не получена: ${error instanceof Error ? error.message : String(error)}`;
    }

    return this.db.transaction(ctx, async (tx) => {
      if (input.entityId) {
        const exists = await tx.query('SELECT 1 FROM intelligence.entities WHERE id = $1', [
          input.entityId,
        ]);
        if (!exists.rowCount)
          throw errors.notFound({ entity: 'intelligence.entity', id: input.entityId });
      }
      const { rows } = await tx.query<SourceRow>(
        input.entityId
          ? `INSERT INTO intelligence.sources
               (id, entity_id, source_url, source_domain, source_title, last_checked_at, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (entity_id, source_url) WHERE entity_id IS NOT NULL
             DO UPDATE SET source_title = coalesce(EXCLUDED.source_title, intelligence.sources.source_title),
                           last_checked_at = coalesce(EXCLUDED.last_checked_at, intelligence.sources.last_checked_at)
             RETURNING *`
          : `INSERT INTO intelligence.sources
               (id, entity_id, source_url, source_domain, source_title, last_checked_at, notes, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (source_url) WHERE entity_id IS NULL
             DO UPDATE SET source_title = coalesce(EXCLUDED.source_title, intelligence.sources.source_title),
                           last_checked_at = coalesce(EXCLUDED.last_checked_at, intelligence.sources.last_checked_at)
             RETURNING *`,
        [
          randomUUID(),
          input.entityId,
          input.url,
          domainOf(input.url),
          title,
          checkedAt,
          fetchNote,
          ctx.userId,
        ],
      );
      return { source: sourceView(rows[0]!), fetched: checkedAt !== null, problem: fetchNote };
    });
  }

  // ------------------------------------------------- импорт get-investor.ru

  /**
   * Каталоги get-investor.ru (ТЗ §9).
   *
   * Сайт на Тильде: карточки каталогов отдаёт её публичный API магазина
   * (`store.tildaapi.com`) — тот же, которым страница рисует себя в браузере.
   * Это структурированный JSON, а не разбор вёрстки, поэтому поля берутся как
   * есть: заголовок, короткое описание, характеристики каталога, ссылка на
   * карточку. Чего в карточке нет — остаётся пустым (ТЗ: «не дополнять
   * данные догадками»).
   *
   * Номера разделов найдены 2026-09-23 по страницам каталогов. Если сайт
   * перестроят, раздел вернёт ноль карточек — это видно в отчёте импорта.
   */
  async importGetInvestor(ctx: RequestContext) {
    const report: {
      catalog: string;
      fetched: number;
      created: number;
      updated: number;
      error?: string;
    }[] = [];
    for (const catalog of GET_INVESTOR_CATALOGS) {
      let products: TildaProduct[];
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
          const outcome = await this.upsertGetInvestorIn(tx, ctx, catalog, product);
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
    catalog: GetInvestorCatalog,
    product: TildaProduct,
  ): Promise<'created' | 'updated'> {
    const fields = mapGetInvestorProduct(catalog, product);
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM intelligence.entities WHERE import_source = 'get-investor' AND external_id = $1`,
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
           (id, type, name, organization_name, description, website_url, email, telegram, linkedin,
            attributes, import_source, external_url, external_id, imported_at, created_by)
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
    await tx.query(
      `INSERT INTO intelligence.sources
         (id, entity_id, source_url, source_domain, source_title, last_checked_at, created_by)
       VALUES ($1, $2, $3, 'get-investor.ru', $4, now(), $5)
       ON CONFLICT (entity_id, source_url) WHERE entity_id IS NOT NULL
       DO UPDATE SET last_checked_at = now()`,
      [randomUUID(), entityId, fields.externalUrl, `Get-Investor · ${catalog.label}`, ctx.userId],
    );
    return outcome;
  }
}

// =================================================== get-investor: разбор

interface GetInvestorCatalog {
  key: string;
  label: string;
  storePart: string;
  type: EntityType;
  /** Поле «Учредитель» в карточке — это организация, названная источником. */
  founderIsOrganization?: boolean;
  /** У мероприятия ссылка в тексте — страница регистрации, а не «Сайт:». */
  firstLinkIsWebsite?: boolean;
}

const GET_INVESTOR_CATALOGS: readonly GetInvestorCatalog[] = [
  {
    key: 'investment-funds',
    label: 'Инвестиционные фонды',
    storePart: '808184690301',
    type: 'fund',
  },
  { key: 'business-angels', label: 'Бизнес-ангелы', storePart: '960638328541', type: 'investor' },
  {
    key: 'investor-clubs',
    label: 'Клубы инвесторов',
    storePart: '969184541201',
    type: 'investor_club',
  },
  {
    key: 'accelerators',
    label: 'Акселераторы',
    storePart: '631093317701',
    type: 'accelerator',
    founderIsOrganization: true,
  },
  {
    key: 'venture-studios',
    label: 'Венчурные студии',
    storePart: '186154586061',
    type: 'organization',
    founderIsOrganization: true,
  },
  {
    key: 'grants-and-subsidies',
    label: 'Гранты и субсидии',
    storePart: '494791447563',
    type: 'other',
  },
  {
    key: 'economic-zones',
    label: 'Особые экономические зоны',
    storePart: '556588871351',
    type: 'other',
  },
  {
    key: 'events-calendar',
    label: 'Календарь мероприятий',
    storePart: '710860811731',
    type: 'event',
    firstLinkIsWebsite: true,
  },
];

interface TildaProduct {
  uid: number | string;
  title: string;
  descr?: string;
  text?: string;
  url?: string;
  gallery?: string;
  characteristics?: { title: string; value: string }[];
}

async function fetchTildaProducts(storePart: string): Promise<TildaProduct[]> {
  const all: TildaProduct[] = [];
  const size = 100;
  for (let slice = 1; slice <= 30; slice += 1) {
    const url =
      `https://store.tildaapi.com/api/getproductslist/?storepartuid=${storePart}` +
      `&getparts=false&getoptions=false&slice=${slice}&size=${size}`;
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, referer: 'https://get-investor.ru/' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`каталог ответил ${response.status}`);
    const body = (await response.json()) as { products?: TildaProduct[]; total?: number | string };
    const page = body.products ?? [];
    all.push(...page);
    const total = Number(body.total ?? 0);
    if (page.length === 0 || all.length >= total) break;
  }
  return all;
}

function mapGetInvestorProduct(catalog: GetInvestorCatalog, product: TildaProduct) {
  const html = product.text ?? '';
  const plain = htmlToText(html);
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => decodeEntities(m[1]!));

  const site = /Сайт[\s\S]{0,80}?<a[^>]+href="([^"]+)"/i.exec(html);
  const websiteUrl = catalog.firstLinkIsWebsite
    ? (hrefs.find((h) => /^https?:\/\//i.test(h)) ?? null)
    : site
      ? decodeEntities(site[1]!)
      : null;

  const characteristics: Record<string, string[]> = {};
  for (const c of product.characteristics ?? []) {
    (characteristics[c.title] ??= []).push(c.value);
  }

  const phone = /Телефон[^:\n]*:\s*([+\d][\d\s().-]{5,}\d)/i.exec(plain)?.[1]?.trim() ?? null;
  const founder = catalog.founderIsOrganization
    ? (/Учредитель\s*:\s*([^\n]+)/i.exec(plain)?.[1]?.trim() ?? null)
    : null;

  const image = firstImage(product.gallery);

  const attributes: Record<string, unknown> = {
    catalog: catalog.key,
    characteristics,
    text: plain,
  };
  if (phone) attributes.phone = phone;
  if (image) attributes.image = image;

  return {
    type: catalog.type,
    name: decodeEntities(product.title).trim().slice(0, 300),
    organizationName: founder ? founder.slice(0, 300) : null,
    description: product.descr ? htmlToText(product.descr).slice(0, 20000) || null : null,
    websiteUrl,
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(plain)?.[0] ?? null,
    telegram: hrefs.find((h) => /(?:t\.me|telegram\.me)\//i.test(h)) ?? null,
    linkedin: hrefs.find((h) => /linkedin\.com\//i.test(h)) ?? null,
    attributes,
    externalId: String(product.uid),
    externalUrl: product.url ?? `https://get-investor.ru/${catalog.key}#${product.uid}`,
  };
}

/** Первая картинка карточки: `gallery` — JSON строкой, и он бывает битым. */
function firstImage(gallery: string | undefined): string | null {
  try {
    return (JSON.parse(gallery ?? '[]') as { img?: string }[])[0]?.img ?? null;
  } catch {
    return null;
  }
}

// ================================================================ HTML

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: ' ',
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    laquo: '«',
    raquo: '»',
    mdash: '—',
    ndash: '–',
    hellip: '…',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(html: string): string | null {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const value = decodeEntities((title ?? og ?? '').replace(/\s+/g, ' ')).trim();
  return value ? value.slice(0, 1000) : null;
}

// ======================================================= безопасная загрузка

const USER_AGENT = 'Mozilla/5.0 (compatible; FifthElementIntelligence/0.1)';

/**
 * Адреса, куда сервер не ходит по ссылке из формы: петля, частные сети,
 * служебные диапазоны облаков. Иначе «Импорт URL» стал бы способом
 * заглянуть изнутри в соседние службы стенда (база, брокер, метаданные).
 */
const FORBIDDEN = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['::ffff:0:0', 96],
] as const) {
  FORBIDDEN.addSubnet(net, prefix, 'ipv6');
}

async function assertPublicHost(url: URL): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('допустимы только адреса http и https');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new Error('нестандартный порт не загружается');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (FORBIDDEN.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      throw new Error('адрес ведёт во внутреннюю сеть');
    }
  }
}

async function safeFetchText(raw: string): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop < 4; hop += 1) {
    await assertPublicHost(url);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*;q=0.5' },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location')!, url);
      continue;
    }
    if (!response.ok) throw new Error(`сайт ответил ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    const limit = 3 * 1024 * 1024;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      chunks.push(value);
      if (size >= limit) {
        await reader.cancel();
        break;
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
  }
  throw new Error('слишком много перенаправлений');
}
