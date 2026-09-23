#!/usr/bin/env node
/**
 * Загрузка находок исследования в Market Intelligence.
 *
 * Исследователи (люди и агенты) пишут находки в JSON-файлы
 * `docs/product/market-intelligence/data/*.json`, а этот скрипт кладёт их в
 * базу. Файлы живут в Git: находка не теряется при сбросе стенда и
 * переносится на любой контур повторным запуском.
 *
 * Формат файла:
 *
 *   {
 *     "run": { "id": "…", "date": "2026-09-23", "method": "как искали" },
 *     "sources":  [ { "url", "name", "is_profile", "source_type", "kind", "description",
 *                     "obtainable", "structure", "public_contacts", "alive", "has_events",
 *                     "has_participant_lists", "parseable", "parser_priority",
 *                     "review_status", "discovery", "via_entity", "represents_entity",
 *                     "notes" } ],
 *     "entities": [ { "name", "type", "organization_name", "description", "website",
 *                     "email", "telegram", "linkedin", "notes" } ],
 *     "facts":    [ { "entity", "entity_type", "page_url", "role", "action", "date",
 *                     "date_precision", "organization", "organization_type", "event",
 *                     "event_type", "verification", "evidence", "notes" } ],
 *     "reject_facts": [ { "entity", "domain", "role", "reason" } ]
 *   }
 *
 * `reject_facts` снимает старых кандидатов (сущность + домен, роль — по
 * желанию), которых перепроверка заменила конкретной страницей или не
 * нашла вовсе.
 *
 * ПРАВИЛА (ТЗ-перестройка §8, §13, §14):
 *  * Подтверждённым факт становится только с конкретной страницей И цитатой
 *    с неё. Без цитаты — кандидат, с пометкой почему.
 *  * Сущность находится по нормализованному имени и типу; для организации —
 *    по имени среди не-людей. Новая заводится, только если не нашлась.
 *  * Разбор источника перезаписывает его признаки, только пока источник не
 *    разобран; разобранный дополняется лишь в пустых полях — правку
 *    человека загрузка не перетирает.
 *  * Повторный запуск безопасен.
 *
 * Запуск: node scripts/intelligence-ingest.mjs [файл.json …]
 *         без аргументов — все файлы каталога data/ по алфавиту.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'docs', 'product', 'market-intelligence', 'data');

loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

const ENTITY_TYPES = new Set([
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
]);
const SOURCE_TYPES = new Set([
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
]);
const oneOf = (value, allowed) => (allowed.includes(value) ? value : null);
const bool = (v) => (v === true || v === false ? v : null);
const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}
const isUrl = (v) => typeof v === 'string' && /^https?:\/\/[^\s]+$/i.test(v) && domainOf(v);

const files =
  process.argv.length > 2
    ? process.argv.slice(2).map((f) => resolve(f))
    : existsSync(DATA)
      ? readdirSync(DATA)
          .filter((f) => f.endsWith('.json'))
          .sort()
          .map((f) => join(DATA, f))
      : [];
if (files.length === 0) {
  console.warn('Файлов с находками нет.');
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const client = await pool.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const problems = [];

/** Сущность по имени: нормализованное имя + тип; организация — среди не-людей. */
async function resolveEntity(
  name,
  type,
  { create = true, organizationLike = false, extra = {} } = {},
) {
  const clean = text(name, 300);
  if (!clean) return null;
  // Ссылка на уже известную сущность без указания типа (собственный сайт,
  // «найден от»): сравнивается только имя — тип здесь не известен.
  if (!create && !ENTITY_TYPES.has(type)) {
    const [any] = await q(
      `SELECT id FROM intelligence.entities
        WHERE intelligence.norm_name(name) = intelligence.norm_name($1)
        ORDER BY (type = 'person') DESC, created_at LIMIT 1`,
      [clean],
    );
    return any ? { id: any.id, created: false } : null;
  }
  const wanted = ENTITY_TYPES.has(type) ? type : organizationLike ? 'organization' : 'other';
  const [found] = await q(
    `SELECT id FROM intelligence.entities
      WHERE intelligence.norm_name(name) = intelligence.norm_name($1)
        AND (type = $2 OR ($3 AND type <> 'person' AND $2 <> 'person'))
      ORDER BY (type = $2) DESC, created_at
      LIMIT 1`,
    [clean, wanted, organizationLike],
  );
  if (found) {
    // Дополняем пустое, заполненного не трогаем.
    await q(
      `UPDATE intelligence.entities
          SET organization_name = coalesce(organization_name, $2),
              description = coalesce(description, $3),
              website_url = coalesce(website_url, $4),
              email = coalesce(email, $5),
              telegram = coalesce(telegram, $6),
              linkedin = coalesce(linkedin, $7)
        WHERE id = $1`,
      [
        found.id,
        text(extra.organization_name, 300),
        text(extra.description, 20000),
        isUrl(extra.website) ? extra.website : null,
        text(extra.email, 320),
        text(extra.telegram, 300),
        text(extra.linkedin, 2000),
      ],
    );
    return { id: found.id, created: false };
  }
  if (!create) return null;
  const id = randomUUID();
  await q(
    `INSERT INTO intelligence.entities
       (id, type, name, organization_name, description, website_url, email, telegram, linkedin,
        notes, attributes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      wanted,
      clean,
      text(extra.organization_name, 300),
      text(extra.description, 20000),
      isUrl(extra.website) ? extra.website : null,
      text(extra.email, 320),
      text(extra.telegram, 300),
      text(extra.linkedin, 2000),
      text(extra.notes, 20000),
      JSON.stringify({ ingestedFrom: extra.run ?? null }),
    ],
  );
  return { id, created: true };
}

/** Источник для страницы: этот адрес, иначе корень того же домена, иначе новый сайт. */
async function resolveSourceForPage(url, discovery) {
  const domain = domainOf(url);
  const [found] = await q(
    `SELECT id FROM intelligence.sources
      WHERE source_url = $1 OR source_domain = $2
      ORDER BY (source_url = $1) DESC,
               starts_with($1, source_url) DESC,
               CASE WHEN starts_with($1, source_url) THEN -length(source_url) ELSE length(source_url) END
      LIMIT 1`,
    [url, domain],
  );
  if (found) return found.id;
  const id = randomUUID();
  await q(
    `INSERT INTO intelligence.sources (id, source_url, source_domain, name, discovery)
     VALUES ($1, $2, $3, $3, $4)`,
    [id, `https://${domain}/`, domain, discovery],
  );
  return id;
}

async function upsertSource(s, run) {
  if (!isUrl(s.url)) {
    problems.push(`источник без адреса: ${s.name ?? JSON.stringify(s).slice(0, 80)}`);
    return null;
  }
  const via = s.via_entity
    ? await resolveEntity(s.via_entity, s.via_entity_type, { create: false })
    : null;
  const rep = s.represents_entity
    ? await resolveEntity(s.represents_entity, s.represents_entity_type, { create: false })
    : null;
  const values = {
    name: text(s.name, 300),
    kind: text(s.kind, 200),
    description: text(s.description, 20000),
    obtainable: text(s.obtainable, 2000),
    structure: oneOf(s.structure, ['high', 'medium', 'low']),
    public_contacts: oneOf(s.public_contacts, ['yes', 'partial', 'no']),
    alive: oneOf(s.alive, ['yes', 'no', 'unknown']),
    parser_priority: oneOf(s.parser_priority, ['high', 'medium', 'low']),
    is_profile: bool(s.is_profile),
    source_type: SOURCE_TYPES.has(s.source_type) ? s.source_type : null,
    has_events: bool(s.has_events),
    has_participant_lists: bool(s.has_participant_lists),
    parseable: oneOf(s.parseable, ['yes', 'partial', 'no']),
    // Проверенность площадки: открыта и разобрана — подтверждена; не
    // открылась — кандидат. Исследователь может явно отклонить (не площадка).
    verification:
      oneOf(s.verification, ['candidate', 'verified', 'rejected']) ??
      (s.review_status === 'checked' ? 'verified' : 'candidate'),
    reliability: oneOf(s.reliability, ['unassessed', 'reliable', 'doubtful']),
    via_entity_id: via?.id ?? null,
    represents_entity_id: rep?.id ?? null,
    notes: text(s.notes, 20000),
  };
  const review = oneOf(s.review_status, ['unchecked', 'checked', 'unreachable']) ?? 'unchecked';
  const discovery = oneOf(s.discovery, ['direct', 'reverse', 'import', 'manual']) ?? run.discovery;
  const cols = Object.keys(values);
  // Неразобранный источник принимает разбор целиком; разобранный — только
  // в пустые поля (правку человека загрузка не перетирает).
  const setters = cols
    .map(
      (c) =>
        `${c} = CASE WHEN intelligence.sources.review_status = 'unchecked'
                     THEN coalesce(EXCLUDED.${c}, intelligence.sources.${c})
                     ELSE coalesce(intelligence.sources.${c}, EXCLUDED.${c}) END`,
    )
    .join(',\n');
  const [row] = await q(
    `INSERT INTO intelligence.sources
       (id, source_url, source_domain, discovery, review_status, last_checked_at, ${cols.join(', ')})
     VALUES ($1, $2, $3, $4, $5, $6, ${cols.map((_, i) => `$${i + 7}`).join(', ')})
     ON CONFLICT (source_url) WHERE entity_id IS NULL
     DO UPDATE SET ${setters},
       review_status = CASE WHEN intelligence.sources.review_status = 'unchecked'
                            THEN EXCLUDED.review_status ELSE intelligence.sources.review_status END,
       last_checked_at = coalesce(EXCLUDED.last_checked_at, intelligence.sources.last_checked_at),
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      randomUUID(),
      s.url,
      domainOf(s.url),
      discovery,
      review,
      review === 'unchecked' ? null : (run.date ?? new Date().toISOString().slice(0, 10)),
      ...cols.map((c) => values[c]),
    ],
  );
  return row;
}

async function ingestFact(f, run) {
  const entityType = ENTITY_TYPES.has(f.entity_type) ? f.entity_type : 'person';
  if (!isUrl(f.page_url)) {
    problems.push(`факт без страницы о «${f.entity}» — пропущен (ТЗ §8)`);
    return null;
  }
  const entity = await resolveEntity(f.entity, entityType, { extra: { run: run.id } });
  if (!entity) {
    problems.push(`факт без сущности: ${JSON.stringify(f).slice(0, 100)}`);
    return null;
  }
  const organization = f.organization
    ? await resolveEntity(f.organization, f.organization_type, {
        organizationLike: true,
        extra: { run: run.id },
      })
    : null;
  const event = f.event
    ? await resolveEntity(f.event, f.event_type ?? 'event', { extra: { run: run.id } })
    : null;
  const sourceId = await resolveSourceForPage(f.page_url, run.discovery);

  let verification = oneOf(f.verification, ['verified', 'candidate', 'rejected']) ?? 'candidate';
  let notes = text(f.notes, 20000);
  if (verification === 'verified' && !text(f.evidence, 2000)) {
    verification = 'candidate';
    notes = [notes, 'подтверждение снято загрузчиком: нет цитаты со страницы']
      .filter(Boolean)
      .join('; ');
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(f.date ?? '') ? f.date : null;
  const precision = date ? (oneOf(f.date_precision, ['day', 'month', 'year']) ?? 'day') : null;

  const [row] = await q(
    `INSERT INTO intelligence.mentions
       (id, entity_id, source_id, page_url, role, action, happened_on, happened_precision,
        organization_id, event_id, verification, verified_at, evidence, notes, last_checked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             CASE WHEN $11 = 'verified' THEN now() END, $12, $13, now())
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
                           THEN 'verified' ELSE intelligence.mentions.verification END,
       verified_at = CASE WHEN EXCLUDED.verification = 'verified'
                               AND intelligence.mentions.verification = 'candidate'
                          THEN now() ELSE intelligence.mentions.verified_at END
     RETURNING (xmax = 0) AS inserted, verification`,
    [
      randomUUID(),
      entity.id,
      sourceId,
      f.page_url,
      text(f.role, 300),
      text(f.action, 4000),
      date,
      precision,
      organization?.id ?? null,
      event?.id ?? null,
      verification,
      text(f.evidence, 2000),
      notes,
    ],
  );
  const created = [entity, organization, event].filter((x) => x?.created).length;
  return { ...row, entitiesCreated: created };
}

const total = {
  sources: 0,
  sourcesNew: 0,
  entitiesNew: 0,
  facts: 0,
  factsNew: 0,
  verified: 0,
  rejected: 0,
};
for (const file of files) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const run = {
    id: data.run?.id ?? file,
    date: data.run?.date ?? null,
    discovery: oneOf(data.run?.discovery, ['direct', 'reverse', 'import', 'manual']) ?? 'direct',
  };
  await client.query('BEGIN');
  try {
    for (const e of data.entities ?? []) {
      const r = await resolveEntity(e.name, e.type, { extra: { ...e, run: run.id } });
      if (r?.created) total.entitiesNew += 1;
    }
    for (const s of data.sources ?? []) {
      const r = await upsertSource(s, run);
      if (!r) continue;
      total.sources += 1;
      if (r.inserted) total.sourcesNew += 1;
    }
    for (const f of data.facts ?? []) {
      const r = await ingestFact(f, run);
      if (!r) continue;
      total.facts += 1;
      if (r.inserted) total.factsNew += 1;
      total.entitiesNew += r.entitiesCreated;
      if (r.verification === 'verified') total.verified += 1;
    }
    // Снять старые КАНДИДАТЫ, которые перепроверка заменила или опровергла:
    // сущность + домен (+ роль, если указана). Подтверждённые не трогаются —
    // понизить подтверждённое вправе только человек.
    for (const r of data.reject_facts ?? []) {
      const rows = await q(
        `UPDATE intelligence.mentions m
            SET verification = 'rejected', verified_at = NULL,
                notes = concat_ws('; ', m.notes, $4::text)
           FROM intelligence.entities e, intelligence.sources s
          WHERE m.entity_id = e.id AND m.source_id = s.id
            AND m.verification = 'candidate'
            AND intelligence.norm_name(e.name) = intelligence.norm_name($1)
            AND s.source_domain = $2
            AND ($3::text IS NULL OR m.role = $3)
          RETURNING m.id`,
        [r.entity, r.domain, r.role ?? null, text(r.reason, 500) ?? `снят перепроверкой ${run.id}`],
      );
      total.rejected += rows.length;
    }
    await client.query('COMMIT');
    console.warn(`  ok    ${file.replace(ROOT, '.')}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.warn(`  FAIL  ${file.replace(ROOT, '.')}: ${error.message}`);
    process.exitCode = 1;
  }
}
client.release();
await pool.end();

console.warn(
  `Источников: ${total.sources} (новых ${total.sourcesNew}); новых сущностей: ${total.entitiesNew}; ` +
    `фактов: ${total.facts} (новых ${total.factsNew}, подтверждённых ${total.verified}); ` +
    `снято кандидатов: ${total.rejected}.`,
);
for (const p of problems) console.warn(`  пропущено: ${p}`);
