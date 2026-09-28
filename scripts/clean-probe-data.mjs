#!/usr/bin/env node
/**
 * Уборка следов прогонов: людей и проекты, заведённые проверками.
 *
 * Зачем. Браузерные проходы и нагрузочные прогоны заводят себе учётные записи
 * при каждом запуске. За неделю их набирается столько, что список
 * пользователей рассказывает не о платформе, а о наших проверках. Разметка
 * происхождения (M127) даёт убирать их точно — по факту создания, а не по
 * догадке об имени.
 *
 * ЧТО ЭТА УБОРКА ДЕЛАЕТ И ЧЕГО НЕ ДЕЛАЕТ.
 *
 * Она ПОМЕЧАЕТ УДАЛЁННЫМИ (`deleted_at`), а не стирает строки. Причина не в
 * осторожности, а в устройстве схемы: акцепты согласий неизменяемы
 * (`consents_immutable`, M002) — их нельзя ни изменить, ни удалить, — а на
 * них висит внешний ключ на пользователя. Физическое удаление строки человека
 * невозможно, пока это правило действует, и обходить его уборка не будет.
 *
 * Что даёт пометка: записи исчезают из всех выдач (каждая фильтрует
 * `deleted_at IS NULL`), а контакт освобождается — уникальность построена
 * частичным индексом. Для стенда этого достаточно; настоящее удаление с
 * обезличиванием — отдельная работа (docs/architecture/application-07-account-deletion.md).
 *
 * ЧЕГО ОНА НЕ ТРОГАЕТ НИКОГДА: людей и проекты любого другого происхождения.
 * Демонстрационный комплект, обстановка приёмки, проверочные записи сотрудника
 * и настоящие регистрации под уборку не попадают по построению — отбор идёт
 * по перечню `PROBE_ORIGINS`, а не по «похоже на тестовое».
 *
 * Команды:
 *   node scripts/clean-probe-data.mjs            показать, что будет убрано
 *   node scripts/clean-probe-data.mjs --yes      убрать
 *   node scripts/clean-probe-data.mjs --hours=2  порог возраста (по умолчанию 24)
 *   node scripts/clean-probe-data.mjs --all      без порога возраста
 */
import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/**
 * В боевом контуре уборка не работает вовсе.
 *
 * Владелец назвал случай, когда проверочные записи заводятся на бою: часть
 * проблем на тестовой среде не воспроизводится. Автоматическая уборка там —
 * это удаление чужих данных по совпадению признака, поэтому её нет.
 */
if (process.env.NODE_ENV === 'production') {
  console.error('clean-probe-data не работает в production: там уборка следов — ручная операция.');
  process.exit(1);
}

const PROBE_ORIGINS = ['render_check', 'load_test'];
const APPLY = process.argv.includes('--yes');
const ALL = process.argv.includes('--all');
const hoursArg = process.argv.find((a) => a.startsWith('--hours='));
const HOURS = hoursArg ? Number(hoursArg.slice('--hours='.length)) : 24;
if (!Number.isFinite(HOURS) || HOURS < 0) {
  console.error('--hours ожидает неотрицательное число часов');
  process.exit(1);
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

const client = new pg.Client({ connectionString: process.env.DATABASE_URL_OWNER });
await client.connect();

/** Условие возраста одно на оба запроса: расхождение дало бы разные выборки. */
const ageCondition = ALL ? 'TRUE' : `created_at < now() - ($2 || ' hours')::interval`;
const params = ALL ? [PROBE_ORIGINS] : [PROBE_ORIGINS, String(HOURS)];

const { rows: users } = await client.query(
  `SELECT origin, count(*)::int AS n FROM identity.users
    WHERE deleted_at IS NULL AND origin = ANY($1::text[]) AND ${ageCondition}
    GROUP BY origin ORDER BY 1`,
  params,
);
const { rows: projects } = await client.query(
  `SELECT origin, count(*)::int AS n FROM lab.projects
    WHERE deleted_at IS NULL AND origin = ANY($1::text[]) AND ${ageCondition}
    GROUP BY origin ORDER BY 1`,
  params,
);

const totalUsers = users.reduce((sum, row) => sum + row.n, 0);
const totalProjects = projects.reduce((sum, row) => sum + row.n, 0);

console.warn('\n=== УБОРКА СЛЕДОВ ПРОГОНОВ ===\n');
console.warn(`  порог возраста: ${ALL ? 'нет (--all)' : `${HOURS} ч`}`);
for (const row of users) console.warn(`  люди    ${String(row.n).padStart(5)}  ${row.origin}`);
for (const row of projects) console.warn(`  проекты ${String(row.n).padStart(5)}  ${row.origin}`);
if (totalUsers === 0 && totalProjects === 0) console.warn('  убирать нечего');

if (!APPLY) {
  console.warn('\n  Это предварительный показ. Убрать: --yes\n');
  await client.end();
  process.exit(0);
}

/**
 * Порядок: сначала проекты, потом люди.
 *
 * Обратный порядок оставил бы проект без владельца в выдачах, которые
 * фильтруют только проект: помеченный человек и живой проект — состояние
 * противоречивое, и видно его не сразу.
 */
await client.query('BEGIN');
try {
  const markedProjects = await client.query(
    `UPDATE lab.projects SET deleted_at = now()
      WHERE deleted_at IS NULL AND origin = ANY($1::text[]) AND ${ageCondition}`,
    params,
  );
  const markedUsers = await client.query(
    `UPDATE identity.users SET deleted_at = now(), updated_at = now()
      WHERE deleted_at IS NULL AND origin = ANY($1::text[]) AND ${ageCondition}`,
    params,
  );
  await client.query('COMMIT');
  console.warn(
    `\n  помечено удалёнными: людей ${markedUsers.rowCount}, проектов ${markedProjects.rowCount}`,
  );
  console.warn('  контакты освобождены — те же адреса снова доступны для регистрации\n');
} catch (error) {
  await client.query('ROLLBACK');
  console.error(
    `\n  уборка не выполнена: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

await client.end();
