#!/usr/bin/env node
/**
 * Живучесть ядра при сбоях базы и брокера — на ОТДЕЛЬНОМ ядре.
 *
 * ЧЕМ ОТЛИЧАЕТСЯ ОТ `check-db-reconnect`. Тот прогон рвёт соединения рабочего
 * стенда и отвечает на вопрос «переживает ли ядро обрыв». Здесь проверяется
 * то, что важнее: что после сбоя РАБОТА ПРОДОЛЖАЕТСЯ — событие доходит,
 * ничего не теряется и не дублируется, фоновые циклы живут дальше.
 *
 * ПОЧЕМУ СВОЁ ЯДРО. Чтобы это проверить, базу надо не только рвать, но и
 * делать недоступной на несколько тактов. На рабочей базе стенда такое
 * означает «положить стенд, пока владелец им пользуется». Поэтому прогон
 * поднимает собственное ядро на ТЕСТОВОЙ базе (`unicorn_test`, порт 4301) и
 * ломает только её:
 *
 *   * обрыв соединений — `pg_terminate_backend` по этой базе;
 *   * недоступность — `ALTER DATABASE … CONNECTION LIMIT 0`: новые
 *     подключения отклоняются, рабочая база не затронута.
 *
 * БРОКЕР ТОЖЕ СВОЙ. Сначала сценарий 4 останавливал общий NATS стенда —
 * отдельная база не делает среду отдельной. Теперь прогон поднимает
 * выделенный экземпляр `unicorn-nats-test` (профиль `testing`, свои порты
 * и том) и останавливает только его. Общий брокер не трогается вовсе, и
 * это проверяется машинно перед остановкой.
 *
 * ВОССТАНОВЛЕНИЕ ОБЯЗАТЕЛЬНО. Предел подключений снимается, брокер
 * поднимается, своё ядро гасится — даже если прогон упал посередине.
 *
 * Запуск: node scripts/check-db-resilience.mjs
 */
import pg from 'pg';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/** Своё ядро и своя база: рабочий стенд этот прогон не трогает. */
const TEST_DB = 'unicorn_test';
const TEST_PORT = 4301;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
/**
 * Брокер прогона. Имя жёсткое и НЕ берётся из окружения намеренно: переменная
 * позволила бы прогону остановить общий брокер стенда по чужой настройке.
 */
const NATS_CONTAINER = 'unicorn-nats-test';
const NATS_TEST_URL = `nats://127.0.0.1:${process.env.NATS_TEST_PORT ?? 4223}`;

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

let passed = 0;
const defects = [];
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    defects.push(name);
    console.error(`  ДЕФЕКТ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function health() {
  try {
    const response = await fetch(`${BASE}/v1/health`, { signal: AbortSignal.timeout(4_000) });
    return response.status;
  } catch {
    return 0;
  }
}

async function waitHealthy(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await health()) === 200) return true;
    await sleep(1_000);
  }
  return false;
}

// ----------------------------------------------------------- своё ядро

/** Переменные окружения ядра с адресами БД, переведёнными на тестовую базу. */
function testCoreEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (!key.startsWith('DATABASE_URL') || key === 'DATABASE_URL_TEST') continue;
    try {
      const url = new URL(env[key]);
      url.pathname = `/${TEST_DB}`;
      env[key] = url.toString();
    } catch {
      /* не адрес — не трогаем */
    }
  }
  env.CORE_PORT = String(TEST_PORT);
  // Свой брокер: иначе прогон публиковал бы в общий стрим стенда и
  // останавливал бы брокер, от которого зависит рабочее ядро.
  env.NATS_URL = NATS_TEST_URL;
  return env;
}

const coreLog = [];
const core = spawn(process.execPath, ['apps/core/dist/main.js'], {
  cwd: ROOT,
  env: testCoreEnv(),
  stdio: ['ignore', 'pipe', 'pipe'],
});
core.stdout.on('data', (chunk) => coreLog.push(chunk.toString()));
core.stderr.on('data', (chunk) => coreLog.push(chunk.toString()));
let coreExited = null;
core.on('exit', (code) => {
  coreExited = code;
});

function tailLog(lines = 6) {
  return (
    coreLog
      .join('')
      // Снимаем цветовые коды консоли. Символ escape собирается по коду:
      // управляющий символ прямо в выражении запрещён линтером и плохо
      // переживает копирование.
      .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
      .trim()
      .split('\n')
      .slice(-lines)
      .join(' | ')
      .slice(0, 300)
  );
}

// ------------------------------------------------------------- база

const admin = new pg.Client({
  connectionString: (() => {
    const url = new URL(process.env.DATABASE_URL_OWNER);
    url.pathname = '/postgres';
    return url.toString();
  })(),
});
const db = new pg.Client({
  connectionString: (() => {
    const url = new URL(process.env.DATABASE_URL_OWNER);
    url.pathname = `/${TEST_DB}`;
    return url.toString();
  })(),
});

/**
 * Оборвать соединения ЯДРА к тестовой базе.
 *
 * Отбор по `application_name` — не педантизм: первая версия рвала всё
 * подряд и обрывала собственное соединение прогона. Клиент `pg` бросал
 * необработанную ошибку, и прогон падал ровно тем же способом, который
 * здесь и проверяется. Рабочая база не затрагивается в любом случае.
 */
async function severConnections() {
  const { rowCount } = await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
        AND application_name LIKE 'unicorn-launch-%'`,
    [TEST_DB],
  );
  return rowCount ?? 0;
}

async function setConnectionLimit(limit) {
  await admin.query(`ALTER DATABASE ${TEST_DB} CONNECTION LIMIT ${limit}`);
}

async function connectionsOfCore() {
  const { rows } = await admin.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = $1 AND application_name LIKE 'unicorn-launch-%'`,
    [TEST_DB],
  );
  return rows[0].n;
}

/** Событие в очереди публикации: по нему видно, продолжилась ли работа. */
async function enqueueEvent(tag) {
  const { rows } = await db.query(
    // Тема (subject) обязана попадать в перечень стрима: `lab.>`, `billing.>`,
    // `identity.>` и далее по списку. Выдуманная тема даёт от JetStream 503
    // «некому принять» — и прогон объявляет дефектом собственные данные.
    // Этим я и обманулся: чинил «сломанную публикацию», которой не было.
    `INSERT INTO audit.outbox_events
       (id, aggregate_type, aggregate_id, aggregate_version, event_type,
        payload_jsonb, nats_subject, schema_version, message_key)
     VALUES (public.uuid_generate_v7(), 'user', public.uuid_generate_v7(), 1,
             'identity.user.suspended', $1::jsonb, 'identity.user.suspended', 1, $2)
     RETURNING id`,
    [JSON.stringify({ check: 'db-resilience', tag }), `resilience-${tag}-${randomUUID()}`],
  );
  return rows[0].id;
}

async function eventState(id) {
  const { rows } = await db.query(
    `SELECT published_at IS NOT NULL AS published, attempts, last_error,
            fanout_completed_at IS NOT NULL AS fanned_out
       FROM audit.outbox_events WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function waitPublished(id, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const state = await eventState(id);
    if (state?.published) return state;
    await sleep(1_000);
  }
  return null;
}

// Свои соединения тоже должны переживать неожиданности: прогон о живучести,
// падающий от разорванного соединения, — плохая шутка.
for (const client of [admin, db]) {
  client.on('error', (error) => {
    console.warn(`  (соединение прогона переподключается: ${error.message.slice(0, 60)})`);
  });
}

let limited = false;
let natsStopped = false;

console.warn('\n=== ЖИВУЧЕСТЬ ЯДРА ПРИ СБОЯХ БАЗЫ И БРОКЕРА ===\n');
console.warn(`  своё ядро: ${BASE}, база ${TEST_DB} — рабочий стенд не затрагивается\n`);

/**
 * Убедиться, что останавливаем именно свой брокер.
 *
 * Машинная проверка перед разрушительным действием, а не доверие имени в
 * переменной: контейнер обязан быть поднят с профилем `testing` и слушать
 * отдельный порт.
 */
function assertOwnBroker() {
  const info = spawnSync(
    'docker',
    [
      'inspect',
      NATS_CONTAINER,
      '--format',
      '{{index .Config.Labels "com.docker.compose.service"}}',
    ],
    { encoding: 'utf8' },
  );
  const service = String(info.stdout ?? '').trim();
  if (service !== 'nats-test') {
    throw new Error(
      `останавливать можно только выделенный брокер: у ${NATS_CONTAINER} служба «${service}»`,
    );
  }
}

try {
  await admin.connect();
  await db.connect();

  // Брокер прогона поднимается прогоном же: обычный `stand:up` его не
  // запускает (профиль `testing`).
  spawnSync(
    'docker',
    [
      'compose',
      '-f',
      join(ROOT, 'infra', 'docker-compose.yml'),
      '--env-file',
      join(ROOT, '.env'),
      '--profile',
      'testing',
      'up',
      '-d',
      'nats-test',
    ],
    { encoding: 'utf8' },
  );
  await sleep(3_000);
  assertOwnBroker();

  check('своё ядро поднялось', await waitHealthy(40_000), tailLog(2));
  if ((await health()) !== 200) throw new Error('ядро не поднялось, проверять нечего');

  // --------------------------------------------------- [1] восстановление
  console.warn('[1] Работа продолжается после обрыва');
  const first = await enqueueEvent('first');
  const publishedBefore = await waitPublished(first, 15_000);
  check('событие обрабатывается до сбоя', Boolean(publishedBefore), first);

  const second = await enqueueEvent('during');
  // Рвём серией, пока событие в обработке: попадание в открытую транзакцию
  // фонового прохода — вопрос времени, и серия его обеспечивает.
  // Трёх обрывов достаточно, чтобы попасть в обработку. Десять накручивали
  // попытки и выдержку повтора до пяти минут — прогон ждал не починку, а
  // собственную серию.
  let severed = 0;
  for (let i = 0; i < 3; i += 1) {
    severed += await severConnections();
    await sleep(400);
  }
  check('соединения оборваны во время обработки', severed > 0, `оборвано: ${severed}`);
  check('ядро не перезапускалось', coreExited === null, `код выхода: ${String(coreExited)}`);

  // Захваченная строка отпускается по истечении аренды (60 с), поэтому
  // ждём с запасом: это не задержка починки, а устройство очереди.
  const publishedAfter = await waitPublished(second, 90_000);
  check(
    'событие дошло без ручного перезапуска',
    Boolean(publishedAfter),
    publishedAfter ? `попыток: ${publishedAfter.attempts}` : 'не опубликовано',
  );

  const third = await enqueueEvent('after');
  check(
    'фоновый цикл продолжает работать',
    Boolean(await waitPublished(third, 90_000)),
    'новое событие после сбоя тоже прошло',
  );

  // ------------------------------------------------------ [2] целостность
  //
  // «Потеряно» — это НЕ «ещё не опубликовано». После обрыва событие ждёт
  // истечения аренды и выдержки повтора; это работа очереди, а не потеря.
  // Потеря выглядит иначе: строка исчезла или исчерпала попытки. Первая
  // версия проверки считала потерянным всё неопубликованное и краснела на
  // исправном поведении.
  console.warn('\n[2] Целостность: ничего не потеряно и не задвоено');
  const { rows: mine } = await db.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE published_at IS NOT NULL)::int AS published,
            count(*) FILTER (WHERE published_at IS NULL
                             AND next_attempt_at IS NOT NULL)::int AS waiting,
            count(*) FILTER (WHERE published_at IS NULL
                             AND next_attempt_at IS NULL)::int AS orphaned,
            max(attempts)::int AS max_attempts
       FROM audit.outbox_events
      WHERE payload_jsonb->>'check' = 'db-resilience'
        AND created_at > now() - interval '15 minutes'`,
  );
  const state = mine[0];
  check(
    'каждое событие либо ушло, либо ждёт повтора',
    state.orphaned === 0,
    `всего ${state.total}: опубликовано ${state.published}, ждут ${state.waiting}, ничьих ${state.orphaned}`,
  );
  // Предел попыток в публикаторе — 10; по его достижении событие перестают
  // брать, и это уже настоящая потеря. Считаем именно исчерпанные, а не
  // «много попыток»: серия обрывов их естественно накручивает, и порог,
  // выдуманный из головы, краснел бы на исправной очереди.
  check(
    'исчерпавших попытки событий нет',
    (state.max_attempts ?? 0) < 10,
    `наибольшее число попыток: ${state.max_attempts} (предел 10)`,
  );

  const { rows: deliveries } = await db.query(
    `SELECT d.event_id, count(*)::int AS n
       FROM integration.webhook_deliveries d
       JOIN audit.outbox_events o ON o.id = d.event_id
      WHERE o.payload_jsonb->>'check' = 'db-resilience'
      GROUP BY d.event_id HAVING count(*) > 1`,
  );
  check(
    'доставка не задвоилась',
    deliveries.length === 0,
    deliveries.length === 0 ? 'по одной на подписчика' : JSON.stringify(deliveries),
  );

  // Признак разорванной посередине транзакции: строка помечена
  // опубликованной, но отметка захвата осталась. `markPublished` снимает
  // `locked_at` тем же выражением, поэтому расхождение означало бы, что
  // половина изменений уцелела, а половина нет.
  const { rows: partial } = await db.query(
    `SELECT count(*)::int AS n FROM audit.outbox_events
      WHERE payload_jsonb->>'check' = 'db-resilience'
        AND published_at IS NOT NULL AND locked_at IS NOT NULL`,
  );
  check(
    'частичных изменений прерванная транзакция не оставила',
    partial[0].n === 0,
    `опубликованных с незакрытым захватом: ${partial[0].n}`,
  );

  // ----------------------------------------------- [3] длительная недоступность
  console.warn('\n[3] База недоступна несколько тактов');
  await setConnectionLimit(0);
  limited = true;
  await severConnections();
  await sleep(10_000); // такт публикатора — секунда, такт доставки — две

  check('ядро живо при недоступной базе', (await health()) === 200 || coreExited === null);
  check('процесс не завершился', coreExited === null, `код выхода: ${String(coreExited)}`);
  const stuck = await connectionsOfCore();
  check(
    'соединения не копятся',
    stuck === 0,
    `соединений ядра к базе во время недоступности: ${stuck}`,
  );

  await setConnectionLimit(-1);
  limited = false;
  const afterOutage = await enqueueEvent('after-outage');
  check(
    'после восстановления работа возобновляется',
    Boolean(await waitPublished(afterOutage, 90_000)),
    'без вмешательства',
  );

  // ------------------------------------------------------------- [4] NATS
  console.warn('\n[4] Брокер уходит и возвращается');
  assertOwnBroker();
  spawnSync('docker', ['stop', NATS_CONTAINER], { encoding: 'utf8' });
  natsStopped = true;
  await sleep(8_000);
  check(
    'ядро пережило уход брокера',
    (await health()) === 200,
    `код выхода: ${String(coreExited)}`,
  );

  const whileDown = await enqueueEvent('nats-down');
  await sleep(4_000);
  const downState = await eventState(whileDown);
  check(
    'событие без брокера копится, а не теряется',
    downState !== null && !downState.published,
    'осталось в очереди',
  );

  spawnSync('docker', ['start', NATS_CONTAINER], { encoding: 'utf8' });
  natsStopped = false;
  await sleep(6_000);
  check(
    'после возврата брокера публикация восстанавливается',
    Boolean(await waitPublished(whileDown, 60_000)),
    'накопленное ушло',
  );

  // ----------------------------------------- [5] детерминированная регрессия
  console.warn('\n[5] Отклонение ВНУТРИ фонового прохода');
  //
  // Серия случайных обрывов попадает в открытую транзакцию не всегда. Здесь
  // момент выбирается точно: прогон берёт исключительную блокировку на
  // таблице очереди, фоновый проход повисает на ней внутри своей транзакции —
  // и именно это соединение обрывается. Без перехвата в фоновом проходе
  // процесс умирает; с перехватом — живёт.
  await enqueueEvent('deterministic');
  const blockerUrl = new URL(process.env.DATABASE_URL_OWNER);
  blockerUrl.pathname = `/${TEST_DB}`;
  const blocker = new pg.Client({ connectionString: blockerUrl.toString() });
  blocker.on('error', () => undefined);
  let blocked = 0;
  try {
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE audit.outbox_events IN ACCESS EXCLUSIVE MODE');

    // Ждём, пока фоновый проход упрётся в блокировку — он будет ждать её
    // внутри открытой транзакции.
    const until = Date.now() + 15_000;
    let victim = null;
    while (Date.now() < until && !victim) {
      const { rows } = await admin.query(
        `SELECT pid FROM pg_stat_activity
          WHERE datname = $1 AND application_name LIKE 'unicorn-launch-%'
            AND wait_event_type = 'Lock'`,
        [TEST_DB],
      );
      victim = rows[0]?.pid ?? null;
      if (!victim) await sleep(500);
    }
    check(
      'фоновый проход пойман внутри транзакции',
      Boolean(victim),
      victim ? `pid ${victim}` : 'не дождались',
    );

    if (victim) {
      const { rowCount } = await admin.query('SELECT pg_terminate_backend($1)', [victim]);
      blocked = rowCount ?? 0;
    }
  } finally {
    await blocker.query('ROLLBACK').catch(() => undefined);
    await blocker.end().catch(() => undefined);
  }
  await sleep(6_000);
  check(
    'ядро пережило отклонение внутри прохода',
    coreExited === null && (await health()) === 200,
    `оборвано прицельно: ${blocked}, код выхода: ${String(coreExited)}`,
  );

  const afterDeterministic = await enqueueEvent('after-deterministic');
  check(
    'после прицельного обрыва очередь снова идёт',
    Boolean(await waitPublished(afterDeterministic, 90_000)),
  );

  // ------------------------------------------- ошибки простаивающих соединений
  console.warn('\n[6] Простаивающие соединения пула');
  const logged = coreLog.join('').includes('ошибка пула соединений');
  check(
    'ошибка простаивающего соединения записана, а не уронила процесс',
    logged && coreExited === null,
    logged ? 'запись в журнале есть' : 'записи нет (обрыв мог не попасть в простой)',
  );
} catch (error) {
  check('прогон выполнен', false, error instanceof Error ? error.message : String(error));
} finally {
  // Восстановление зависимостей обязательно и при собственном падении.
  if (limited) await setConnectionLimit(-1).catch(() => undefined);
  if (natsStopped) spawnSync('docker', ['start', NATS_CONTAINER], { encoding: 'utf8' });
  core.kill();
  await admin.end().catch(() => undefined);
  await db.end().catch(() => undefined);
}

if (defects.length > 0) console.warn(`\nхвост журнала ядра: ${tailLog(8)}`);
console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);
