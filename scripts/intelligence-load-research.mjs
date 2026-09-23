#!/usr/bin/env node
/**
 * Загрузка исследовательского прохода в Market Intelligence.
 *
 * Читает docs/product/market-intelligence/источники-рынка.md и переносит в
 * базу то, что там найдено:
 *  * таблицы источников (§1.1 живые, §1.2 непроверенные) → intelligence.sources
 *    с признаками из ТЗ §17 (тип, что даёт, структурированность, контакты);
 *  * приоритеты парсеров (§3) → sources.parser_priority по домену;
 *  * обратный поиск (§2) → источники `reverse` от человека и УПОМИНАНИЯ этого
 *    человека в них: так у сущности появляется «где ещё встречается».
 *
 * Повторный запуск безопасен: источники узнаются по адресу, упоминания — по
 * тройке «сущность, источник, страница»; заполненное человеком не
 * перетирается (только пустые поля).
 *
 * Запуск: node scripts/intelligence-load-research.mjs
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = join(ROOT, 'docs', 'product', 'market-intelligence', 'источники-рынка.md');

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

const text = readFileSync(FILE, 'utf8');
const lines = text.split('\n');

/** Строки таблицы между заголовком `startsWith` и следующим заголовком. */
function tableRows(heading) {
  const start = lines.findIndex((l) => l.startsWith(heading));
  if (start < 0) throw new Error(`нет раздела «${heading}»`);
  const rows = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^#{2,3} /.test(line)) break;
    if (!line.startsWith('|') || /^\|\s*-/.test(line)) continue;
    rows.push(
      line
        .slice(1, line.trimEnd().endsWith('|') ? line.trimEnd().length - 1 : undefined)
        .split('|')
        .map((c) => c.trim()),
    );
  }
  return rows.slice(1); // первая строка — заголовок таблицы
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

const structure = (v) =>
  /^высок/i.test(v) ? 'high' : /^средн/i.test(v) ? 'medium' : /^низк/i.test(v) ? 'low' : null;
const contacts = (v) =>
  /^да/i.test(v) ? 'yes' : /^частич/i.test(v) ? 'partial' : /^нет/i.test(v) ? 'no' : null;
const alive = (v) => (/^да/i.test(v) ? 'yes' : /^нет/i.test(v) ? 'no' : 'unknown');
const dash = (v) => (!v || v === '—' ? null : v);

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

/** Источник по адресу: заводится или дополняет пустые поля. */
async function upsertSource(s) {
  const [row] = await q(
    `INSERT INTO intelligence.sources
       (id, source_url, source_domain, name, kind, description, obtainable, structure,
        public_contacts, alive, discovery, via_entity_id, discovered_at, last_checked_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14)
     ON CONFLICT (source_url) WHERE entity_id IS NULL
     DO UPDATE SET name = coalesce(intelligence.sources.name, EXCLUDED.name),
                   kind = coalesce(intelligence.sources.kind, EXCLUDED.kind),
                   description = coalesce(intelligence.sources.description, EXCLUDED.description),
                   obtainable = coalesce(intelligence.sources.obtainable, EXCLUDED.obtainable),
                   structure = coalesce(intelligence.sources.structure, EXCLUDED.structure),
                   public_contacts = coalesce(intelligence.sources.public_contacts, EXCLUDED.public_contacts),
                   alive = coalesce(intelligence.sources.alive, EXCLUDED.alive),
                   via_entity_id = coalesce(intelligence.sources.via_entity_id, EXCLUDED.via_entity_id),
                   notes = coalesce(intelligence.sources.notes, EXCLUDED.notes),
                   updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      randomUUID(),
      s.url,
      domainOf(s.url),
      s.name ?? null,
      s.kind ?? null,
      s.description ?? null,
      s.obtainable ?? null,
      s.structure ?? null,
      s.publicContacts ?? null,
      s.alive ?? null,
      s.discovery,
      s.viaEntityId ?? null,
      s.checkedAt ?? new Date(),
      s.notes ?? null,
    ],
  );
  return row;
}

const counts = { sources: 0, sourcesNew: 0, priorities: 0, mentions: 0, skipped: [] };

// ------------------------------------------------ §1.1 и §1.2: источники
for (const r of tableRows('### 1.1.')) {
  const [, name, kind, rawCell, description, obtainable, struct, contact, date, isAlive] = r;
  // В ячейке бывает приписка («… (xlsx: …)») — берётся только сама ссылка.
  const url = /^https?:\/\/\S+/.exec(rawCell)?.[0] ?? rawCell;
  if (!/^https?:\/\//.test(url)) {
    counts.skipped.push(`${name}: адрес не ссылка (${url})`);
    continue;
  }
  const row = await upsertSource({
    url,
    name,
    kind: dash(kind),
    description: dash(description),
    obtainable: dash(obtainable),
    structure: structure(struct),
    publicContacts: contacts(contact),
    alive: alive(isAlive),
    discovery: 'direct',
    checkedAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date) : new Date(),
    notes:
      [
        /\(/.test(struct) ? `Структурированность: ${struct}` : null,
        /\(/.test(isAlive) ? `Жив: ${isAlive}` : null,
      ]
        .filter(Boolean)
        .join('\n') || null,
  });
  counts.sources += 1;
  if (row.inserted) counts.sourcesNew += 1;
}

for (const r of tableRows('### 1.2.')) {
  const [name, kind, rawUrl, what, struct, isAlive] = r;
  const url = /^https?:\/\//.test(rawUrl) ? rawUrl : `https://${rawUrl}/`;
  if (!domainOf(url)) {
    counts.skipped.push(`${name}: адрес не разобран (${rawUrl})`);
    continue;
  }
  const row = await upsertSource({
    url,
    name,
    kind: dash(kind),
    structure: structure(struct),
    alive: /^нет/i.test(isAlive) ? 'no' : 'unknown',
    discovery: 'direct',
    notes: `Не проверен 2026-09-23: ${what}`,
  });
  counts.sources += 1;
  if (row.inserted) counts.sourcesNew += 1;
}

// ------------------------------------------------- §3: приоритеты парсера
const DOMAIN_RE =
  /\b((?:[a-z0-9-]+\.)+(?:ru|com|vc|work|team|net|org|io|me|media|app|agency|fm|kz|moscow|events|today|digital))\b(\/[^\s,;)»|]*)?/gi;
for (const [level, name, reason] of tableRows('## 3.')) {
  const priority = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' }[level];
  if (!priority) continue;
  const domains = new Set([...name.matchAll(DOMAIN_RE)].map((m) => m[1].toLowerCase()));
  for (const domain of domains) {
    const updated = await q(
      `UPDATE intelligence.sources
          SET parser_priority = coalesce(parser_priority, $2),
              notes = CASE WHEN notes IS NULL THEN $3
                           WHEN position($3 in notes) > 0 THEN notes
                           ELSE notes || E'\n' || $3 END,
              updated_at = now()
        WHERE source_domain = $1 OR source_domain LIKE '%.' || $1
        RETURNING id`,
      [domain, priority, `Парсер (${level}): ${reason}`],
    );
    counts.priorities += updated.length;
    if (updated.length === 0)
      counts.skipped.push(`приоритет ${level} для ${domain}: источника нет`);
  }
}

// ---------------------------------------------- §2: обратный поиск от людей
const start = lines.findIndex((l) => l.startsWith('## 2.'));
const end = lines.findIndex((l, i) => i > start && l.startsWith('## 3.'));
let person = null;
for (const line of lines.slice(start + 1, end)) {
  const head = /^### (.+?)(?:\s+—.*|\s+\(.*)?$/.exec(line);
  if (head) {
    const name = head[1].trim();
    const [found] = await q(
      `SELECT id, name, notes FROM intelligence.entities WHERE lower(name) = lower($1) LIMIT 1`,
      [name],
    );
    person = found ?? null;
    if (!found && name !== 'Что повторяется у всех') {
      counts.skipped.push(`обратный поиск: сущности «${name}» нет в базе`);
    }
    if (found && /Галицкий/.test(name) && !found.notes) {
      await q(`UPDATE intelligence.entities SET notes = $2, updated_at = now() WHERE id = $1`, [
        found.id,
        '⚠ Репутационный риск: по выдаче поиска (pravo.ru, CNews, Fontanka, The Moscow Times, ' +
          'март–май 2026) суд признал деятельность Галицкого и Almaz Capital «экстремистским ' +
          'объединением». Первоисточники не открывались. В маркетинге не использовать до ' +
          'юридической оценки. См. источники-рынка.md §2.',
      ]);
    }
    continue;
  }
  if (!person) continue;
  const bullet = /^- \*\*(.+?):\*\*\s*(.+)$/.exec(line);
  if (!bullet || /^Вывод/i.test(bullet[1])) continue;
  const [, label, body] = bullet;
  for (const m of body.matchAll(DOMAIN_RE)) {
    const domain = m[1].toLowerCase();
    const url = `https://${domain}${m[2] ?? '/'}`;
    const source = await upsertSource({
      url,
      name: domain,
      discovery: 'reverse',
      viaEntityId: person.id,
      notes: `Обратный поиск от «${person.name}»: ${label.toLowerCase()}.`,
    });
    counts.sources += 1;
    if (source.inserted) counts.sourcesNew += 1;
    const inserted = await q(
      // Кандидат, а не подтверждённый факт: агент видел выдачу, страниц не
      // открывал (ТЗ-перестройка §8). Роль — подпись пункта из файла.
      `INSERT INTO intelligence.mentions
         (id, entity_id, source_id, page_url, role, verification, notes)
       VALUES ($1, $2, $3, $4, $5, 'candidate', 'из выдачи поиска, страница не открывалась')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [randomUUID(), person.id, source.id, url, label],
    );
    counts.mentions += inserted.length;
  }
}

await pool.end();
console.warn(
  `Источников обработано: ${counts.sources} (новых ${counts.sourcesNew}); ` +
    `приоритетов парсера проставлено: ${counts.priorities}; новых упоминаний: ${counts.mentions}.`,
);
for (const s of counts.skipped) console.warn(`  пропущено: ${s}`);
