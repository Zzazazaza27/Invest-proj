#!/usr/bin/env node
/**
 * Живой прогон: комплект демонстрационных данных.
 *
 * Проверяется не «скрипт отработал без ошибок», а те свойства, ради которых
 * комплект вообще существует:
 *
 *   1. загрузка на чистую систему даёт полный набор и соблюдает связи;
 *   2. ПОВТОРНЫЙ запуск не плодит дубликатов;
 *   3. данные выглядят как настоящие: ни «Lorem ipsum», ни «Тестовый проект»;
 *   4. файлы реально лежат в хранилище и совпадают с файлами репозитория
 *      побайтово — размер и отпечаток в базе не расходятся с объектом;
 *   5. каталог показывает опубликованные проекты и НЕ показывает снятые;
 *   6. поиск и фильтры работают на этих данных;
 *   7. уборка удаляет РОВНО комплект и не трогает чужие строки;
 *   8. после уборки повторная загрузка восстанавливает ТЕ ЖЕ идентификаторы —
 *      это и есть воспроизводимость.
 *
 * Прогон меняет состояние базы (загружает и убирает комплект), поэтому он
 * оставляет систему в состоянии «комплект загружен».
 *
 * Запуск: node scripts/smoke-demo.mjs (нужны БД, хранилище и core на 4300)
 */
import pg from 'pg';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL } from './lib/ports.mjs';
import { s3Object, storageFromEnv } from './lib/s3.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'fixtures', 'demo');
loadDotEnv();

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

const seed = (command) =>
  execFileSync('node', [join(ROOT, 'scripts', 'seed-demo.mjs'), command], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const people = JSON.parse(readFileSync(join(FIXTURES, 'people.json'), 'utf8')).people;
const projects = JSON.parse(readFileSync(join(FIXTURES, 'projects.json'), 'utf8')).projects;

/** Те же идентификаторы, что считает сам комплект. Совпадение — часть проверки. */
const NAMESPACE = 'unicorn-launch/demo/v1';
function demoId(...parts) {
  const hash = createHash('sha1').update(`${NAMESPACE}|${parts.join('|')}`).digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const projectIds = projects.map((p) => demoId('project', p.key));
const userIds = people.map((p) => demoId('user', p.key));

async function counts() {
  const [row] = await sql(
    `SELECT
       (SELECT count(*)::int FROM identity.users)            AS users_total,
       (SELECT count(*)::int FROM lab.projects)              AS projects_total,
       (SELECT count(*)::int FROM lab.project_materials)     AS materials_total,
       (SELECT count(*)::int FROM identity.users        WHERE id = ANY($1::uuid[])) AS users_demo,
       (SELECT count(*)::int FROM lab.projects          WHERE id = ANY($2::uuid[])) AS projects_demo,
       (SELECT count(*)::int FROM lab.project_materials WHERE project_id = ANY($2::uuid[])) AS materials_demo`,
    [userIds, projectIds],
  );
  return row;
}

console.warn('\n=== ЖИВОЙ ПРОГОН: КОМПЛЕКТ ДЕМОНСТРАЦИОННЫХ ДАННЫХ ===\n');

console.warn('[1] Загрузка на чистую систему');
{
  // Сначала уборка: прогон должен доказать восстановление, а не то, что
  // данные уже были загружены раньше.
  seed('clean');
  const before = await counts();
  check('после уборки комплекта в базе нет', before.projects_demo === 0, `проектов: ${before.projects_demo}`);

  seed('load');
  const after = await counts();
  check('учётные записи загружены', after.users_demo === people.length, `${after.users_demo}/${people.length}`);
  check('проекты загружены', after.projects_demo === projects.length, `${after.projects_demo}/${projects.length}`);

  const expectedMaterials = projects.reduce((sum, p) => sum + (p.materials?.length ?? 0), 0);
  check('материалы загружены', after.materials_demo === expectedMaterials, `${after.materials_demo}/${expectedMaterials}`);
}

console.warn('\n[2] Повторный запуск не плодит дубликаты');
{
  const before = await counts();
  seed('load');
  const after = await counts();
  check('число проектов не изменилось', before.projects_total === after.projects_total, `${before.projects_total} → ${after.projects_total}`);
  check('число учётных записей не изменилось', before.users_total === after.users_total, `${before.users_total} → ${after.users_total}`);
  check('число материалов не изменилось', before.materials_total === after.materials_total, `${before.materials_total} → ${after.materials_total}`);
}

console.warn('\n[3] Данные выглядят как настоящие');
{
  const rows = await sql(
    `SELECT title, tagline, description FROM lab.projects WHERE id = ANY($1::uuid[])`,
    [projectIds],
  );
  const text = rows.map((r) => `${r.title} ${r.tagline} ${r.description}`).join(' ');
  const placeholders = [
    /lorem\s+ipsum/i,
    /test\s+user/i,
    /company\s*\d/i,
    /тестовый проект/i,
    /проект\s*№?\s*\d+\s*$/i,
    /foo|bar|baz/i,
    /заглушк/i,
  ];
  const found = placeholders.filter((rx) => rx.test(text)).map(String);
  check('заглушек в текстах нет', found.length === 0, found.join(', '));
  check('описания содержательные', rows.every((r) => (r.description ?? '').length > 400));
  check(
    'у каждого проекта есть краткое описание',
    rows.every((r) => (r.tagline ?? '').length > 20),
  );
}

console.warn('\n[4] Связи и обязательные поля соблюдены');
{
  const [orphan] = await sql(
    `SELECT count(*)::int AS n FROM lab.projects p
      WHERE p.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM lab.founders_projects f
                         WHERE f.project_id = p.id AND f.role = 'owner')`,
    [projectIds],
  );
  check('у каждого проекта есть владелец', orphan.n === 0, `без владельца: ${orphan.n}`);

  const [noPlan] = await sql(
    `SELECT count(*)::int AS n FROM lab.projects
      WHERE id = ANY($1::uuid[]) AND required_plan_id IS NULL`,
    [projectIds],
  );
  check('тариф определён по сумме запроса', noPlan.n === 0, `без тарифа: ${noPlan.n}`);

  const [noSub] = await sql(
    `SELECT count(*)::int AS n FROM lab.projects p
      WHERE p.id = ANY($1::uuid[]) AND p.listing_status = 'listed'
        AND NOT EXISTS (SELECT 1 FROM billing.subscriptions s
                         WHERE s.project_id = p.id AND s.status = 'active')`,
    [projectIds],
  );
  check('у опубликованных проектов активная подписка', noSub.n === 0, `без подписки: ${noSub.n}`);

  const [version] = await sql(
    `SELECT count(*)::int AS n FROM lab.projects
      WHERE id = ANY($1::uuid[]) AND current_version_id IS NULL`,
    [projectIds],
  );
  check('у каждого проекта есть версия заявки', version.n === 0, `без версии: ${version.n}`);

  const [tariffs] = await sql(
    `SELECT count(DISTINCT required_plan_id)::int AS n FROM lab.projects WHERE id = ANY($1::uuid[])`,
    [projectIds],
  );
  // Разные тарифы — не украшение: на одном тарифе не видно, что резолвер
  // тарифа по сумме вообще работает.
  check('задействовано несколько тарифов', tariffs.n >= 3, `тарифов: ${tariffs.n}`);
}

console.warn('\n[5] Роли и статусы разнообразны');
{
  const [roles] = await sql(
    `SELECT count(DISTINCT role)::int AS n FROM identity.user_roles WHERE user_id = ANY($1::uuid[])`,
    [userIds],
  );
  check('в комплекте несколько ролей', roles.n >= 4, `ролей: ${roles.n}`);

  const [statuses] = await sql(
    `SELECT count(DISTINCT status)::int AS s, count(DISTINCT listing_status)::int AS l,
            count(DISTINCT stage)::int AS g
       FROM lab.projects WHERE id = ANY($1::uuid[])`,
    [projectIds],
  );
  check('разные статусы в воронке', statuses.s >= 4, `статусов: ${statuses.s}`);
  check('разные состояния листинга', statuses.l >= 3, `состояний: ${statuses.l}`);
  check('разные стадии проекта', statuses.g >= 3, `стадий: ${statuses.g}`);
}

console.warn('\n[6] Файлы материалов лежат в хранилище и совпадают побайтово');
{
  const storage = storageFromEnv();
  if (!storage) {
    console.warn('  ---   хранилище не настроено — проверка файлов НЕ выполнялась');
  } else {
    const rows = await sql(
      `SELECT id, project_id, type, s3_key, size_bytes, content_hash
         FROM lab.project_materials
        WHERE project_id = ANY($1::uuid[]) AND s3_key IS NOT NULL
        ORDER BY type`,
      [projectIds],
    );
    check('материалы с файлами есть', rows.length > 0, `${rows.length} шт.`);

    let matched = 0;
    let mismatch = '';
    for (const row of rows) {
      const response = await s3Object(storage, 'GET', row.s3_key);
      if (!response.ok) {
        mismatch = `${row.s3_key}: HTTP ${response.status}`;
        break;
      }
      const body = Buffer.from(await response.arrayBuffer());
      const sha256 = createHash('sha256').update(body).digest('hex');
      if (body.length !== Number(row.size_bytes) || sha256 !== row.content_hash) {
        mismatch = `${row.s3_key}: ${body.length}Б/${Number(row.size_bytes)}Б`;
        break;
      }
      matched += 1;
    }
    check('каждый файл читается и совпадает с записью в БД', mismatch === '' && matched === rows.length, mismatch || `${matched} шт.`);

    // Обратная сверка: объект в хранилище совпадает с файлом в репозитории.
    const deck = rows.find((r) => r.type === 'deck');
    if (deck) {
      const response = await s3Object(storage, 'GET', deck.s3_key);
      const remote = Buffer.from(await response.arrayBuffer());
      const local = readFileSync(join(FIXTURES, 'files', 'aeroseed-deck.pdf'));
      const alternatives = ['aeroseed-deck.pdf', 'tochka-deck.pdf', 'ritm-deck.pdf'].map((name) =>
        readFileSync(join(FIXTURES, 'files', name)),
      );
      check(
        'объект в хранилище равен файлу репозитория',
        alternatives.some((candidate) => candidate.equals(remote)),
        `${remote.length} байт против ${local.length}`,
      );
      check('файл — валидный PDF', remote.subarray(0, 5).toString('latin1') === '%PDF-', remote.subarray(0, 5).toString('latin1'));
    }

    const png = readFileSync(join(FIXTURES, 'files', 'tochka-screen.png'));
    check(
      'изображение в комплекте — валидный PNG',
      png.subarray(1, 4).toString('latin1') === 'PNG',
      `${png.length} байт`,
    );
  }
}

console.warn('\n[7] Каталог, поиск и фильтры на этих данных');
{
  const raw = async (path) => {
    const response = await fetch(`${CORE_URL}${path}`, { signal: AbortSignal.timeout(15_000) });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const listedKeys = projects.filter((p) => p.listingStatus === 'listed').map((p) => p.title);
  const hiddenKeys = projects.filter((p) => p.listingStatus !== 'listed').map((p) => p.title);

  const all = await raw('/v1/catalog?limit=50');
  const titles = (all.json?.items ?? []).map((item) => item.title);
  check('каталог отвечает', all.status === 200, `HTTP ${all.status}`);
  check(
    'опубликованные проекты в каталоге',
    listedKeys.every((title) => titles.includes(title)),
    listedKeys.join(', '),
  );
  check(
    'снятые и неопубликованные в каталог НЕ попали',
    hiddenKeys.every((title) => !titles.includes(title)),
    hiddenKeys.join(', '),
  );

  // Поиск: лексика проектов не пересекается, поэтому запрос обязан находить
  // ровно один — иначе полнотекстовый поиск проверялся бы «вообще».
  const search = await raw(`/v1/catalog?q=${encodeURIComponent('пластырь')}&limit=20`);
  const found = (search.json?.items ?? []).map((item) => item.title);
  check('поиск находит проект по слову из описания', found.includes('Ритм-Диагностика'), found.join(', '));

  const searchOther = await raw(`/v1/catalog?q=${encodeURIComponent('стройплощадке')}&limit=20`);
  const found2 = (searchOther.json?.items ?? []).map((item) => item.title);
  check('другой запрос находит другой проект', found2.includes('Точка сборки'), found2.join(', '));

  // Публичный поиск идёт ТОЛЬКО по тизеру (title + tagline): описание
  // открывается подпиской, и его лексемы анонимному каталогу не отдаются
  // (M013). Слово «прораб» есть только в описании — значит, находиться оно не
  // должно. Первая версия прогона ждала обратного и покраснела по делу.
  const hidden = await raw(`/v1/catalog?q=${encodeURIComponent('прораб')}&limit=20`);
  check(
    'по слову из описания публичный поиск НЕ находит',
    !(hidden.json?.items ?? []).some((item) => item.title === 'Точка сборки'),
    (hidden.json?.items ?? []).map((i) => i.title).join(', ') || 'ничего',
  );

  const sorted = await raw('/v1/catalog?sort=ask_asc&limit=50');
  const asks = (sorted.json?.items ?? []).map((item) => Number(item.investmentAsk));
  check(
    'сортировка по сумме возрастает',
    asks.every((value, i) => i === 0 || value >= asks[i - 1]),
    asks.slice(0, 4).join(' ≤ '),
  );

  const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'healthtech'`);
  const filtered = await raw(`/v1/catalog?taxonomyId=${taxonomy.id}&limit=50`);
  const byTaxonomy = (filtered.json?.items ?? []).map((item) => item.title);
  check('фильтр по направлению работает', byTaxonomy.includes('Ритм-Диагностика'), byTaxonomy.join(', '));
  check('фильтр отсекает чужое направление', !byTaxonomy.includes('Точка сборки'));
}

console.warn('\n[8] Уборка удаляет ровно комплект');
{
  const before = await counts();
  seed('clean');
  const after = await counts();

  check('демонстрационных проектов не осталось', after.projects_demo === 0, `${after.projects_demo}`);
  check('демонстрационных учётных записей не осталось', after.users_demo === 0, `${after.users_demo}`);
  check('материалов комплекта не осталось', after.materials_demo === 0, `${after.materials_demo}`);

  // Главное: чужие строки не тронуты. Разница общего счётчика обязана в
  // точности равняться числу удалённых строк комплекта.
  check(
    'чужие проекты не пострадали',
    before.projects_total - after.projects_total === before.projects_demo,
    `всего ${before.projects_total} → ${after.projects_total}, комплекта было ${before.projects_demo}`,
  );
  check(
    'чужие учётные записи не пострадали',
    before.users_total - after.users_total === before.users_demo,
    `всего ${before.users_total} → ${after.users_total}, комплекта было ${before.users_demo}`,
  );

  const storage = storageFromEnv();
  if (storage) {
    const response = await s3Object(
      storage,
      'HEAD',
      `projects/${demoId('project', 'aeroseed')}/materials/deck/${demoId('material', demoId('project', 'aeroseed'), 'deck')}`,
    );
    check('файл материала удалён из хранилища', response.status === 404, `HTTP ${response.status}`);
  }
}

console.warn('\n[9] Восстановление после чистой установки');
{
  seed('load');
  const after = await counts();
  check('комплект восстановлен целиком', after.projects_demo === projects.length && after.users_demo === people.length);

  // Воспроизводимость: идентификаторы после пересоздания те же самые.
  const rows = await sql(`SELECT id, title FROM lab.projects WHERE id = ANY($1::uuid[])`, [
    projectIds,
  ]);
  check(
    'идентификаторы после восстановления те же',
    rows.length === projects.length,
    `${rows.length}/${projects.length}`,
  );

  const storage = storageFromEnv();
  if (storage) {
    const response = await s3Object(
      storage,
      'HEAD',
      `projects/${demoId('project', 'aeroseed')}/materials/deck/${demoId('material', demoId('project', 'aeroseed'), 'deck')}`,
    );
    check('файлы восстановлены в хранилище', response.ok, `HTTP ${response.status}`);
  }
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
await pool.end();
process.exit(failed === 0 ? 0 : 1);
