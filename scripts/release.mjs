#!/usr/bin/env node
/**
 * Выпуск комплекта в среду и сверка версий (W09c, блок 9, задание 1).
 *
 *   node scripts/release.mjs install <среда> --kit <сборка> --expect <сборка|none>
 *                                    --actor <кто> --approved-by <кто> [--rollback]
 *   node scripts/release.mjs verify  <среда>
 *   node scripts/release.mjs replay  <среда>
 *   node scripts/release.mjs recover <среда> --op <id> --note <причина>
 *
 * Блокировка общая: операция `running` в реестре среды, уникальная на среду. Без
 * подтверждённого захвата выпуск не начинается, в том числе при недоступной базе:
 * локальный журнал блокировку не заменяет. Выпуск привязан к ожидаемой текущей сборке,
 * устаревшее задание получает отказ; откат — только явным `--rollback`.
 *
 * Журнал `.local/envs/<среда>/release-journal.jsonl` пишется первым: прерванная
 * операция оставляет сведения для разбора, а записи при упавшей базе доносит `replay`
 * по ID без дублей. Операция, оборванная на середине, держит блокировку, пока её не
 * закроет `recover` с причиной: автоматически блокировка не снимается.
 *
 * Результат — строка JSON. Код завершения: 0 готово, 1 не удалось, 2 отказ.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOrder } from './kit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = join(ROOT, 'infra', 'docker-compose.env.yml');
const ENVS = process.env.FIFTH_ENVS_DIR || join(ROOT, '.local', 'envs');
const KITS = process.env.FIFTH_KITS_DIR || join(ROOT, '.local', 'kits');
const SERVER = process.env.FIFTH_SERVER || 'local';
const COMPONENTS = ['core', 'web', 'postgres'];
const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

class Refused extends Error {}

const finish = (result, code) => {
  console.log(JSON.stringify(result));
  process.exit(code);
};

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const dirOf = (id) => join(ENVS, id);
const instanceId = (id, component) => `${id}/${SERVER}/${component}`;

function psql(id, sql) {
  const r = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      join(dirOf(id), 'compose.env'),
      '-f',
      COMPOSE,
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      'psql "$(cat /run/secrets/DATABASE_URL_APP_RELEASE)" -v ON_ERROR_STOP=1 -At',
    ],
    { input: sql, encoding: 'utf8', env: dockerEnv, timeout: 30_000 },
  );
  if (r.status !== 0) {
    const e = new Error((r.stderr || 'база недоступна').trim().split('\n').pop());
    e.sqlState = /duplicate key|installations_one_running/.test(r.stderr ?? '') ? '23505' : null;
    throw e;
  }
  return r.stdout.trim();
}

const journalFile = (id) => join(dirOf(id), 'release-journal.jsonl');

/** Запись в журнал идёт первой: она переживает и сбой базы, и падение процесса. */
function record(id, op, stage, result, detail = null) {
  const event = { id: randomUUID(), op, at: new Date().toISOString(), stage, result, detail };
  appendFileSync(journalFile(id), `${JSON.stringify(event)}\n`);
  try {
    psql(id, insertEvent(event));
    return true;
  } catch {
    return false;
  }
}

const insertEvent = (e) =>
  `INSERT INTO ops.installation_events (id, installation_id, at, stage, result, detail)
   VALUES (${q(e.id)}, ${q(e.op)}, ${q(e.at)}, ${q(e.stage)}, ${q(e.result)}, ${q(e.detail)})
   ON CONFLICT (id) DO NOTHING;`;

function readKit(build) {
  const file = join(KITS, build, 'kit.json');
  if (!existsSync(file)) throw new Refused(`комплекта ${build} нет`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function kitTool(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'kit.mjs'), ...args], {
    encoding: 'utf8',
    env: dockerEnv,
  });
  if (r.status !== 0) throw new Error(`kit ${args[0]}: ${r.stdout.trim() || r.stderr.trim()}`);
}

function envTool(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'env.mjs'), ...args], {
    encoding: 'utf8',
    env: dockerEnv,
  });
  return { code: r.status, out: r.stdout.trim() };
}

/** Текущая сборка среды — последняя успешная установка. */
const currentBuild = (id) =>
  psql(
    id,
    `SELECT build FROM ops.installations WHERE env = ${q(id)} AND status = 'succeeded'
      ORDER BY finished_at DESC LIMIT 1;`,
  ) || null;

function older(a, b) {
  const [x, y] = [buildOrder(a), buildOrder(b)];
  if (!x || !y) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Фактическое состояние: запущенный контейнер и готовность, а не сообщение CI. */
function observe(id, kit) {
  const out = [];
  for (const component of COMPONENTS) {
    const name = `fifth-${id}-${component}`;
    const r = spawnSync('docker', ['inspect', name, '--format', '{{.Image}}|{{.State.Status}}'], {
      encoding: 'utf8',
      env: dockerEnv,
    });
    const [image, state] = r.status === 0 ? r.stdout.trim().split('|') : [null, 'absent'];
    out.push({
      instance: instanceId(id, component),
      component,
      image,
      state,
      expected: kit?.images[component]?.imageId ?? null,
    });
  }
  return out;
}

function readiness(id) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'env.mjs'), 'status', id], {
    encoding: 'utf8',
    env: dockerEnv,
  });
  try {
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {
    return { ready: false };
  }
}

function verifyAgainst(id, kit) {
  const seen = observe(id, kit);
  const status = readiness(id);
  const at = new Date().toISOString();
  const rows = seen.map((s) => ({
    ...s,
    match: s.state === 'running' && s.image === s.expected,
  }));
  let migrations;
  try {
    const applied = psql(id, 'SELECT id FROM public.schema_migrations ORDER BY id;').split('\n');
    const expected = kit.migrations.map((m) => m.id);
    const missing = expected.filter((m) => !applied.includes(m));
    migrations = { expected: expected.length, applied: applied.length, missing };
  } catch {
    migrations = null;
  }
  const confirmed = rows.filter((r) => r.match).length;
  const ok = confirmed === rows.length && status.ready === true && migrations?.missing.length === 0;
  return { ok, at, confirmed, total: rows.length, rows, ready: status.ready === true, migrations };
}

const upsertInstances = (id, v) =>
  v.rows
    .map(
      (r) => `INSERT INTO ops.instances
        (instance_id, env, component, actual_image, state, ready, confirmed_at, source)
       VALUES (${q(r.instance)}, ${q(id)}, ${q(r.component)}, ${q(r.image)}, ${q(r.state)},
               ${r.component === 'core' ? v.ready : 'NULL'}, ${q(v.at)}, 'docker inspect, /ready')
       ON CONFLICT (instance_id) DO UPDATE SET
         actual_image = EXCLUDED.actual_image, state = EXCLUDED.state, ready = EXCLUDED.ready,
         confirmed_at = EXCLUDED.confirmed_at, source = EXCLUDED.source
       WHERE ops.instances.confirmed_at < EXCLUDED.confirmed_at;`,
    )
    .join('\n');

async function install(id) {
  const build = flag('--kit');
  const expect = flag('--expect');
  const actor = flag('--actor');
  const approved = flag('--approved-by');
  const rollback = argv.includes('--rollback');
  if (!build || !expect || !actor || !approved) {
    throw new Refused('нужны --kit, --expect, --actor и --approved-by');
  }
  const kit = readKit(build);
  const op = randomUUID();

  // Захват блокировки подтверждает база: без него шагов дальше нет.
  let current;
  try {
    current = currentBuild(id);
  } catch (e) {
    throw new Refused(`блокировка не подтверждена, выпуск не начат: ${e.message}`);
  }
  if ((current ?? 'none') !== expect) {
    throw new Refused(`среда на сборке ${current ?? 'none'}, ожидалась ${expect}`);
  }
  if (current && older(build, current) && !rollback) {
    throw new Refused(`сборка ${build} старше текущей ${current}: откат только с --rollback`);
  }
  try {
    psql(
      id,
      `INSERT INTO ops.installations
         (id, env, build, commit_sha, kit_sha256, expected_build, actor, approved_by, kind)
       VALUES (${q(op)}, ${q(id)}, ${q(build)}, ${q(kit.commit)}, ${q(kit.tar.sha256)},
               ${q(current)}, ${q(actor)}, ${q(approved)}, ${q(rollback ? 'rollback' : 'install')});`,
    );
  } catch (e) {
    if (e.sqlState === '23505') throw new Refused('в этой среде уже идёт выпуск');
    throw new Refused(`блокировка не подтверждена, выпуск не начат: ${e.message}`);
  }
  record(id, op, 'lock', 'ok', `сборка ${build}, было ${current ?? 'none'}`);
  psql(
    id,
    COMPONENTS.map(
      (c) => `INSERT INTO ops.installation_targets
        (installation_id, instance_id, component, role, expected_image)
       VALUES (${q(op)}, ${q(instanceId(id, c))}, ${q(c)}, 'serving', ${q(kit.images[c].imageId)});`,
    ).join('\n'),
  );

  const close = (status, detail) => {
    record(id, op, 'finish', status, detail);
    try {
      psql(
        id,
        `UPDATE ops.installations SET status = ${q(status)}, detail = ${q(detail)},
           finished_at = now() WHERE id = ${q(op)};`,
      );
    } catch {
      /* запись в журнале, `replay` донесёт */
    }
  };

  try {
    kitTool('load', '--build', build);
    record(id, op, 'load', 'ok');
    if (process.env.FIFTH_TEST_CRASH === 'after-load') process.exit(97);
    const up = envTool('update', id, '--kit', build);
    if (up.code !== 0) throw new Error(`установка: ${up.out.slice(0, 200)}`);
    record(id, op, 'update', 'ok');
    const v = verifyAgainst(id, kit);
    record(id, op, 'verify', v.ok ? 'ok' : 'fail', `подтверждено ${v.confirmed} из ${v.total}`);
    psql(id, upsertInstances(id, v));
    if (!v.ok) throw new Error(`сверка: подтверждено ${v.confirmed} из ${v.total}`);
    close('succeeded', `подтверждено ${v.confirmed} из ${v.total}`);
    finish({ ok: true, env: id, op, build, confirmed: v.confirmed, total: v.total }, 0);
  } catch (e) {
    close('failed', e.message);
    finish({ ok: false, env: id, op, build, error: e.message }, 1);
  }
}

function verify(id) {
  const build = currentBuild(id);
  if (!build) throw new Refused('в реестре нет успешной установки');
  const v = verifyAgainst(id, readKit(build));
  psql(id, upsertInstances(id, v));
  finish(
    {
      ok: v.ok,
      env: id,
      build,
      confirmed: v.confirmed,
      total: v.total,
      ready: v.ready,
      migrations: v.migrations,
      differ: v.rows.filter((r) => !r.match).map((r) => r.instance),
    },
    v.ok ? 0 : 1,
  );
}

function replay(id) {
  if (!existsSync(journalFile(id))) finish({ ok: true, env: id, sent: 0 }, 0);
  const events = readFileSync(journalFile(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const before = Number(psql(id, 'SELECT count(*) FROM ops.installation_events;'));
  for (const e of events) {
    psql(id, insertEvent(e));
    if (e.stage === 'finish') {
      psql(
        id,
        `UPDATE ops.installations SET status = ${q(e.result)}, detail = ${q(e.detail)},
           finished_at = ${q(e.at)} WHERE id = ${q(e.op)} AND status = 'running';`,
      );
    }
  }
  const after = Number(psql(id, 'SELECT count(*) FROM ops.installation_events;'));
  finish({ ok: true, env: id, journal: events.length, sent: after - before }, 0);
}

function recover(id) {
  const op = flag('--op');
  const note = flag('--note');
  if (!op || !note) throw new Refused('нужны --op <id> и --note <причина>');
  const stage = existsSync(journalFile(id))
    ? readFileSync(journalFile(id), 'utf8')
        .split('\n')
        .filter((l) => l.includes(op))
        .map((l) => JSON.parse(l).stage)
        .pop()
    : null;
  const done = psql(
    id,
    `UPDATE ops.installations SET status = 'interrupted', finished_at = now(),
       detail = ${q(`${note}; последний этап: ${stage ?? 'нет'}`)}
     WHERE id = ${q(op)} AND status = 'running' RETURNING id;`,
  );
  if (!done) throw new Refused(`операции ${op} в работе нет`);
  record(id, op, 'recover', 'interrupted', note);
  finish({ ok: true, env: id, op, lastStage: stage ?? null }, 0);
}

const COMMANDS = { install, verify, replay, recover };

try {
  const [command, id] = argv;
  if (!COMMANDS[command]) throw new Refused(`команды нет: ${command ?? '(нет)'}`);
  if (!/^test-[1-9][0-9]*$/.test(id ?? '')) {
    throw new Refused('выпуск на рабочую среду — в W09d; сейчас только test-N');
  }
  if (!existsSync(join(dirOf(id), 'install.json'))) throw new Refused(`среда ${id} не установлена`);
  await COMMANDS[command](id);
} catch (e) {
  const refused = e instanceof Refused;
  finish({ ok: false, refused, error: e.message }, refused ? 2 : 1);
}
