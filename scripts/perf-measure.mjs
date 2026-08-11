#!/usr/bin/env node
/**
 * Замеры на синтетическом объёме сезона.
 *
 * Существует потому, что «индексы созданы по спецификации» и «запрос быстрый»
 * — разные утверждения. На единичных данных планировщик выбирает
 * последовательное чтение и укладывается в доли миллисекунды: такой замер
 * доказывает только то, что таблица пуста.
 *
 * Здесь создаётся отдельный синтетический сезон, наполняется проектами,
 * рейтингами и договорами, после чего снимаются ФАКТИЧЕСКИЕ планы ключевых
 * запросов (`EXPLAIN ANALYZE`) и время пересчёта рейтинга.
 *
 * Данные помечены собственным сезоном и удаляются в `finally` — прогон,
 * оставляющий за собой мусор, ломает следующий и искажает будущие замеры.
 *
 * Запуск: node scripts/perf-measure.mjs [--projects 20000]
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const argIndex = process.argv.indexOf('--projects');
const PROJECTS = argIndex > 0 ? Number(process.argv[argIndex + 1]) : 20_000;

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();

let seasonId = null;
let failures = 0;

/**
 * Порог замера. Не «красивое число»: каталог и реестр — интерактивные экраны,
 * и всё, что дольше 200 мс на объёме одного сезона, пользователь чувствует.
 * Пересчёту рейтинга дано больше — это фоновая операция организатора.
 */
const BUDGETS = { query: 200, refresh: 5000 };

function report(name, ms, budget, plan) {
  const ok = ms <= budget;
  if (!ok) failures += 1;
  console.warn(
    `  ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(46)} ${ms.toFixed(1)} мс (бюджет ${budget})`,
  );
  if (plan) console.warn(`       ${plan}`);
}

/** Ключевая строка плана: способ доступа к таблице — по индексу или чтением всей. */
function accessMethod(planText) {
  const line = planText
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.startsWith('->') || s.startsWith('Index') || s.startsWith('Seq'));
  return (line ?? planText.split('\n')[0] ?? '').slice(0, 110);
}

async function explain(name, sql, params, budget = BUDGETS.query) {
  const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`, params);
  const planText = rows.map((r) => r['QUERY PLAN']).join('\n');
  const ms = Number(/Execution Time: ([\d.]+) ms/.exec(planText)?.[1] ?? NaN);
  report(name, ms, budget, accessMethod(planText));
  return planText;
}

try {
  console.warn(`\n=== ЗАМЕРЫ НА СИНТЕТИЧЕСКОМ ОБЪЁМЕ (${PROJECTS} проектов) ===\n`);
  console.warn('--- подготовка данных ---');
  const started = Date.now();

  const [season] = (
    await client.query(
      `INSERT INTO seasons.seasons (id, number, title, starts_at, ends_at, status)
       VALUES (public.uuid_generate_v7(),
               (SELECT coalesce(max(number), 0) + 1 FROM seasons.seasons),
               'СИНТЕТИКА замера', now() - interval '1 day', now() + interval '30 days', 'review')
       RETURNING id`,
    )
  ).rows;
  seasonId = season.id;

  // Публикация в каталоге требует владельца и активной подписки нужного тарифа
  // (lab.can_list_project, M009). Обходить эту проверку ради замера нельзя:
  // измерять надо каталог, который получается по правилам платформы, а не
  // строки, вставленные мимо них. Поэтому синтетике даётся настоящий владелец
  // и настоящая подписка.
  const [owner] = (
    await client.query(
      `SELECT id FROM identity.users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    )
  ).rows;
  if (!owner) throw new Error('в базе нет ни одного пользователя: сначала npm run db:seed');

  // Одна вставка вместо цикла: генерация на стороне БД исключает сеть из
  // подготовки и не искажает измеряемое время. Проекты создаются НЕ
  // опубликованными, публикация — отдельным шагом после подписок.
  await client.query(
    `INSERT INTO lab.projects
       (id, taxonomy_id, season_id, title, tagline, stage, status, listing_status, listed_at,
        geo_country, investment_ask, ask_currency, required_plan_id)
     SELECT public.uuid_generate_v7(),
            (SELECT id FROM lab.project_taxonomy ORDER BY random() LIMIT 1),
            $1,
            'Синтетический проект ' || g,
            'Тизер ' || g,
            (ARRAY['idea','mvp','early_revenue','growth'])[1 + (g % 4)],
            'expert_review',
            'not_listed',
            now() - (g || ' minutes')::interval,
            (ARRAY['RU','KZ','BY','AM'])[1 + (g % 4)],
            (1000000 + (g % 500) * 100000)::numeric,
            'RUB',
            billing.resolve_founder_plan((1000000 + (g % 500) * 100000)::numeric)
       FROM generate_series(1, $2) AS g`,
    [seasonId, PROJECTS],
  );

  await client.query(
    `INSERT INTO lab.founders_projects (project_id, user_id, role)
     SELECT p.id, $2, 'owner' FROM lab.projects p WHERE p.season_id = $1`,
    [seasonId, owner.id],
  );

  await client.query(
    `INSERT INTO billing.subscriptions
       (id, user_id, plan_id, project_id, price_snapshot, currency_snapshot, terms_version,
        status, current_period_end)
     SELECT public.uuid_generate_v7(), $2, p.required_plan_id, p.id,
            pl.price, 'RUB', 'v1', 'active', now() + interval '30 days'
       FROM lab.projects p
       JOIN billing.subscription_plans pl ON pl.id = p.required_plan_id
      WHERE p.season_id = $1`,
    [seasonId, owner.id],
  );

  await client.query(`UPDATE lab.projects SET listing_status = 'listed' WHERE season_id = $1`, [
    seasonId,
  ]);

  // Рейтинг считается по последнему значению IRS: без скорингов представление
  // осталось бы пустым, и замер пересчёта ничего бы не измерил.
  await client.query(
    `INSERT INTO scoring.irs_scores (id, project_id, value, computed_at)
     SELECT public.uuid_generate_v7(), p.id, round((random() * 100)::numeric, 2), now()
       FROM lab.projects p WHERE p.season_id = $1`,
    [seasonId],
  );

  await client.query('ANALYZE lab.projects');
  await client.query('ANALYZE scoring.irs_scores');
  console.warn(`  данные подготовлены за ${((Date.now() - started) / 1000).toFixed(1)} с`);

  const [{ count }] = (
    await client.query('SELECT count(*)::int AS count FROM lab.projects WHERE season_id = $1', [
      seasonId,
    ])
  ).rows;
  console.warn(`  проектов в сезоне: ${count}`);

  console.warn('\n--- планы ключевых запросов ---');

  await explain(
    'каталог: первая страница',
    `SELECT id, taxonomy_id, title, tagline, stage, geo_country,
            investment_ask::text, ask_currency, listed_at
       FROM lab.projects
      WHERE listing_status = 'listed' AND deleted_at IS NULL
      ORDER BY listed_at DESC, id DESC
      LIMIT 21`,
    [],
  );

  const [{ listed_at: cursorAt, id: cursorId }] = (
    await client.query(
      `SELECT listed_at, id FROM lab.projects
        WHERE season_id = $1 ORDER BY listed_at DESC, id DESC OFFSET 5000 LIMIT 1`,
      [seasonId],
    )
  ).rows;

  await explain(
    'каталог: страница по курсору (5000-я)',
    `SELECT id, title, listed_at
       FROM lab.projects
      WHERE listing_status = 'listed' AND deleted_at IS NULL
        AND (listed_at, id) < ($1::timestamptz, $2::uuid)
      ORDER BY listed_at DESC, id DESC
      LIMIT 21`,
    [cursorAt, cursorId],
  );

  await explain(
    'каталог: полнотекстовый поиск',
    `SELECT id, title FROM lab.projects
      WHERE listing_status = 'listed' AND deleted_at IS NULL
        AND public_search_tsv @@ plainto_tsquery('russian', $1)
      ORDER BY listed_at DESC, id DESC
      LIMIT 21`,
    ['синтетический'],
  );

  await explain(
    'каталог: фильтр по сумме и стадии',
    `SELECT id, title FROM lab.projects
      WHERE listing_status = 'listed' AND deleted_at IS NULL
        AND stage = 'growth' AND investment_ask BETWEEN $1::numeric AND $2::numeric
      ORDER BY listed_at DESC, id DESC
      LIMIT 21`,
    ['2000000', '20000000'],
  );

  await explain(
    'отбор: проекты сезона на этапе',
    `SELECT id, title FROM lab.projects
      WHERE season_id = $1 AND status = 'expert_review' AND deleted_at IS NULL
      LIMIT 100`,
    [seasonId],
  );

  await explain(
    'реестр договоров: страница',
    `SELECT a.id, a.status, a.contract_amount, a.created_at
       FROM investments.investment_agreements a
       JOIN investments.investment_offers o ON o.id = a.offer_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 21`,
    [],
  );

  console.warn('\n--- пересчёт рейтинга сезона ---');
  const refreshStarted = Date.now();
  await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY seasons.mv_season_rating');
  report('REFRESH MATERIALIZED VIEW CONCURRENTLY', Date.now() - refreshStarted, BUDGETS.refresh);

  const [{ n }] = (
    await client.query(
      'SELECT count(*)::int AS n FROM seasons.mv_season_rating WHERE season_id = $1',
      [seasonId],
    )
  ).rows;
  console.warn(`  строк рейтинга по синтетическому сезону: ${n}`);
  if (n !== count) {
    failures += 1;
    console.warn(`  FAIL рейтинг покрыл ${n} проектов из ${count}`);
  }

  await explain(
    'рейтинг: первая страница',
    `SELECT rank, project_id, title, irs FROM seasons.mv_season_rating
      WHERE season_id = $1 ORDER BY rank LIMIT 50`,
    [seasonId],
  );
} finally {
  // Уборка обязательна и в случае падения: синтетические 20 тысяч проектов,
  // оставшиеся в базе, попадут в каталог и в следующий замер.
  if (seasonId) {
    console.warn('\n--- уборка ---');
    // IRS append-only: «рейтинг не продаётся» (M006). Удаление синтетики —
    // законное исключение, но оно должно быть ЯВНЫМ и узким: триггер снимается
    // ровно на время уборки и возвращается сразу, а не «пока не мешает».
    await client.query('ALTER TABLE scoring.irs_scores DISABLE TRIGGER irs_immutable');
    try {
      await client.query(
        `DELETE FROM scoring.irs_scores WHERE project_id IN
           (SELECT id FROM lab.projects WHERE season_id = $1)`,
        [seasonId],
      );
    } finally {
      await client.query('ALTER TABLE scoring.irs_scores ENABLE TRIGGER irs_immutable');
    }
    await client.query(
      `DELETE FROM billing.subscriptions WHERE project_id IN
         (SELECT id FROM lab.projects WHERE season_id = $1)`,
      [seasonId],
    );
    await client.query(
      `DELETE FROM lab.founders_projects WHERE project_id IN
         (SELECT id FROM lab.projects WHERE season_id = $1)`,
      [seasonId],
    );
    await client.query('DELETE FROM lab.projects WHERE season_id = $1', [seasonId]);
    await client.query('DELETE FROM seasons.seasons WHERE id = $1', [seasonId]);
    await client.query('REFRESH MATERIALIZED VIEW CONCURRENTLY seasons.mv_season_rating');
    console.warn('  синтетические данные удалены, рейтинг пересчитан');
  }
  await client.end();
}

console.warn(
  `\n=== ИТОГ: ${failures === 0 ? 'все замеры в бюджете' : `превышений: ${failures}`} ===\n`,
);
process.exit(failures > 0 ? 1 : 0);
