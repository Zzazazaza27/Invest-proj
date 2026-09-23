#!/usr/bin/env node
/**
 * Market Intelligence: проверка фактов по исходной странице.
 *
 * Факт подтверждён, если страница открыта и сущность на ней действительно
 * есть (ТЗ-перестройка §8). Исследователи подтверждают это цитатой, но
 * цитата бывает неполной — подпись должности без имени, которое стоит на
 * странице соседним элементом, — а инструмент загрузки страниц местами
 * пересказывает текст вместо дословного копирования.
 *
 * Скрипт скачивает страницы фактов (обычным запросом, честно подписанным,
 * по одной на сайт с паузой) и ищет в тексте имя сущности:
 *  * кандидат, пониженный за «не видно имени в цитате», при найденном
 *    имени снова становится подтверждённым — с пометкой, как проверен;
 *  * подтверждённый НЕ понижается: у страниц, которые рисуются скриптом,
 *    имени в исходном HTML может не быть — это не опровержение;
 *  * отдельно считается, у скольких подтверждённых фактов цитата дословно
 *    не находится на странице (пересказ) — для отчёта, без изменений.
 *
 * Запуск: node scripts/intelligence-verify-pages.mjs [--limit N]
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namedIn } from './lib/intel-names.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

const LIMIT = Number(process.argv[process.argv.indexOf('--limit') + 1]) || Infinity;
const UA = 'Mozilla/5.0 (compatible; FifthElementIntelligence/0.1; fact check)';

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&laquo;|&raquo;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, ' ');
}

const norm = (s) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„'`]/g, '"')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,*/*;q=0.5' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = response.headers.get('content-type') ?? '';
  if (!/html|text/i.test(type)) throw new Error(`не HTML (${type})`);
  const buf = Buffer.from(await response.arrayBuffer()).subarray(0, 4 * 1024 * 1024);
  return htmlToText(new TextDecoder('utf-8', { fatal: false }).decode(buf));
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 2 });
const q = async (sql, params = []) => (await pool.query(sql, params)).rows;

// Карточки каталога get-investor.ru подтверждены импортом (данные из API
// сайта, страница рисуется скриптом) — их проверять здесь незачем.
const facts = await q(
  `SELECT m.id, m.page_url, m.evidence, m.verification, m.notes, e.name, e.type
     FROM intelligence.mentions m
     JOIN intelligence.entities e ON e.id = m.entity_id
    WHERE m.page_url IS NOT NULL
      AND m.page_url NOT LIKE 'https://get-investor.ru/%'
      AND (m.verification = 'verified'
           OR (m.verification = 'candidate' AND m.notes LIKE '%не видно имени сущности%'))`,
);

const byPage = new Map();
for (const f of facts) {
  if (!byPage.has(f.page_url)) byPage.set(f.page_url, []);
  byPage.get(f.page_url).push(f);
}

const pages = [...byPage.keys()].slice(0, LIMIT);
const lastHit = new Map();
const stats = {
  pages: 0,
  failed: 0,
  upgraded: 0,
  stillMissing: 0,
  verifiedChecked: 0,
  quoteNotVerbatim: 0,
  verifiedNameAbsent: 0,
};
const absent = [];
const failures = new Map();

async function worker(queue) {
  for (;;) {
    const url = queue.shift();
    if (!url) return;
    const host = new URL(url).hostname;
    const wait = (lastHit.get(host) ?? 0) + 1500 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHit.set(host, Date.now());
    let text;
    try {
      text = await fetchText(url);
      stats.pages += 1;
    } catch (error) {
      stats.failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
      continue;
    }
    const page = norm(text);
    for (const f of byPage.get(url)) {
      const present = namedIn(f.name, f.type, text);
      if (f.verification === 'candidate') {
        if (present) {
          await q(
            `UPDATE intelligence.mentions
                SET verification = 'verified', verified_at = now(),
                    notes = concat_ws('; ', notes,
                      'подтверждено автопроверкой: имя сущности найдено на странице')
              WHERE id = $1 AND verification = 'candidate'`,
            [f.id],
          );
          stats.upgraded += 1;
        } else {
          stats.stillMissing += 1;
        }
      } else {
        stats.verifiedChecked += 1;
        const probe = f.evidence ? norm(f.evidence).slice(0, 60) : null;
        if (probe && probe.length >= 20 && !page.includes(probe)) stats.quoteNotVerbatim += 1;
        if (!present) {
          stats.verifiedNameAbsent += 1;
          absent.push(`${f.name} — ${url}`);
        }
      }
    }
  }
}

const queue = [...pages];
await Promise.all(Array.from({ length: 4 }, () => worker(queue)));
await pool.end();

console.warn(
  `Страниц: ${pages.length} (получено ${stats.pages}, не получено ${stats.failed}). ` +
    `Кандидаты «не видно имени»: возвращено в подтверждённые ${stats.upgraded}, ` +
    `имени нет и на странице ${stats.stillMissing}. ` +
    `Подтверждённых проверено ${stats.verifiedChecked}, из них цитата не дословна ${stats.quoteNotVerbatim}, ` +
    `имени на странице не видно ${stats.verifiedNameAbsent} (не понижены: страница может рисоваться скриптом).`,
);
for (const line of absent.slice(0, 40)) console.warn(`  имени не видно: ${line}`);
for (const [reason, n] of [...failures].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.warn(`  не получено: ${reason} — ${n}`);
}
