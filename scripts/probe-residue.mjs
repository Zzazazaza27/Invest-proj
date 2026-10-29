#!/usr/bin/env node
/**
 * Что оставили прогоны: перечень, а не уборка.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОГОН. Уборка по догадке — худший способ терять данные:
 * «похоже на тестовое», «название с цифрами», «создано сегодня» опираются на
 * совпадение признаков, а не на факт. Поэтому здесь ничего не удаляется.
 * Скрипт отвечает на один вопрос: какие записи ДОКАЗУЕМО созданы прогонами
 * и что от них зависит.
 *
 * ЧТО СЧИТАЕТСЯ ДОКАЗАННЫМ. Только два основания, и оба — факт, записанный
 * в момент создания:
 *
 *   1. происхождение самой записи (`origin` в перечне следов прогонов);
 *   2. авторство: запись создана человеком, чьё происхождение — след
 *      прогона. Так находятся справочные записи, у которых своего
 *      происхождения нет, — если у справочника есть колонка авторства;
 *   3. принадлежность запуску: строка числится в перечне объектов тестовой
 *      сессии.
 *
 * Всё остальное — «похоже» — в перечень не попадает и здесь не
 * перечисляется.
 *
 * После 2.1-W05 из справочников остались только страны обслуживания, и
 * колонки авторства у них нет: такие строки называются отдельно как
 * недоказуемые — решение по ним принимает владелец, а не скрипт.
 *
 * Запуск: node scripts/probe-residue.mjs
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
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

/** Происхождения, которые платформа считает следом прогона (M127). */
const PROBE_ORIGINS = ['render_check', 'load_test', 'test_session'];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL,
  application_name: 'unicorn-probe-residue',
});
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

console.warn('\n=== ЧТО ОСТАВИЛИ ПРОГОНЫ ===\n');
console.warn('  Ничего не удаляется. Это перечень, а не уборка.\n');

try {
  // --------------------------------------------------------------- люди
  const people = await sql(
    `SELECT origin, count(*)::int AS n, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS gone
       FROM identity.users WHERE origin = ANY($1::text[]) GROUP BY origin ORDER BY 1`,
    [PROBE_ORIGINS],
  );
  console.warn('  ЛЮДИ (по собственному происхождению)');
  if (people.length === 0) console.warn('    нет');
  for (const row of people) {
    console.warn(
      `    ${row.origin.padEnd(16)} всего ${String(row.n).padStart(4)}, ` +
        `уже помечено удалёнными ${row.gone}`,
    );
  }

  // ------------------------------------------------- учтённые за запусками
  const tracked = await sql(
    `SELECT o.table_name, count(*)::int AS n,
            count(DISTINCT o.session_id)::int AS runs
       FROM testing.session_objects o GROUP BY o.table_name ORDER BY 1`,
  );
  console.warn('\n  ЧИСЛЯТСЯ ЗА ЗАПУСКАМИ (перечень объектов сессий)');
  if (tracked.length === 0) console.warn('    нет');
  for (const row of tracked) {
    console.warn(
      `    ${row.table_name.padEnd(24)} ${String(row.n).padStart(4)} строк, запусков ${row.runs}`,
    );
  }

  /*
   * СПРАВОЧНИКИ ПО АВТОРСТВУ.
   *
   * У справочников нет своего происхождения: строка не знает, что её
   * завёл прогон. Если известен автор, а у автора происхождение есть, —
   * этого достаточно, чтобы утверждать факт, а не предполагать.
   */
  const byAuthor = [['billing.service_countries', 'created_by']];
  /*
   * КАНДИДАТЫ, А НЕ ДОКАЗАННЫЕ ОСТАТКИ.
   *
   * Единственное основание здесь — происхождение АВТОРА строки
   * (`identity.users.origin`). До M136 это происхождение можно было
   * подделать: клиент объявлял свои записи тестовыми заголовком
   * `X-Unicorn-Origin`, и сервер верил. Значит про строки, заведённые
   * раньше, «это след прогона» — предположение, а не доказательство.
   *
   * Поэтому перечень называется тем, чем является: кандидатами. Удалять
   * по нему нельзя; уточнять — журналами аудита и данными конкретных
   * запусков.
   */
  console.warn('\n  СПРАВОЧНИКИ: КАНДИДАТЫ НА ТЕСТОВЫЕ ОСТАТКИ (по автору)');
  let residue = 0;
  const unprovable = [];
  for (const [table, column] of byAuthor) {
    const exists = await sql(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = split_part($1, '.', 1)
          AND table_name = split_part($1, '.', 2) AND column_name = $2`,
      [table, column],
    );
    if (exists.length === 0) {
      /*
       * Колонки авторства нет — значит доказать происхождение этих строк
       * НЕЧЕМ. Ни «созданы сегодня», ни «похожи на тестовые» основанием не
       * являются: под такое описание попадают и настоящие настройки
       * владельца. Таблица остаётся нетронутой и называется отдельно, чтобы
       * отсутствие доказательства было видно, а не подразумевалось.
       */
      unprovable.push(table);
      continue;
    }
    const rows = await sql(
      `SELECT count(*)::int AS n FROM ${table} t
        WHERE t.${column} IN (SELECT id FROM identity.users WHERE origin = ANY($1::text[]))`,
      [PROBE_ORIGINS],
    );
    const n = rows[0]?.n ?? 0;
    residue += n;
    console.warn(`    ${table.padEnd(34)} ${String(n).padStart(4)}`);
  }

  console.warn(
    `\n  Кандидатов на тестовые остатки в справочниках: ${residue} строк.\n` +
      '  Основание одно — происхождение автора строки. До M136 его можно\n' +
      '  было подделать заголовком, поэтому для записей тех времён это\n' +
      '  предположение, а не доказательство. Удалять по этому перечню\n' +
      '  нельзя.',
  );

  if (unprovable.length > 0) {
    console.warn('\n  ДОКАЗАТЕЛЬСТВ НЕТ — не трогаем:');
    for (const table of unprovable) {
      console.warn(`    ${table} — в таблице нет колонки авторства`);
    }
    console.warn(
      '\n  Эти строки могли завести и прогоны, и владелец. Отличить нечем,\n' +
        '  поэтому они остаются как есть. Считать их мусором по дате или\n' +
        '  названию — тот же способ потерять чужую работу.',
    );
  }

  console.warn(
    '\n  ЧТО С ЭТИМ ДЕЛАТЬ — решает владелец. Прогоны, которые заводят\n' +
      '  справочные записи, работают в одноразовой базе\n' +
      '  (`npm run temp:up`, пометка `circuit: temp` в реестре), и новые\n' +
      '  строки такого рода в рабочей базе не появляются.\n',
  );
} finally {
  await pool.end();
}
