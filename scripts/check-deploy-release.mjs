#!/usr/bin/env node
/**
 * Проверка порядка выпуска и решения об откате — без сервера.
 *
 * `deploy.mjs` выкатывает на боевой стенд, и сценарий сбоя на нём не
 * отрепетируешь. Поэтому шаг выпуска вынесен в `lib/deploy-release.mjs`, а
 * здесь он гоняется против ИМИТАЦИИ сервера: имитация понимает те же команды
 * (git, systemctl, migrate:status, grep меток, db:migrate) и ведёт состояние —
 * коммит кода, работающие сервисы, применённые миграции.
 *
 * Главный инвариант, ради которого проверка написана (2.1-W05, M150): ни в
 * какой момент ядро на коде, который не знает о contract-миграции, не
 * работает над базой, где она применена. Имитация отмечает каждое такое
 * мгновение как нарушение.
 *
 * Сценарии:
 *   1. contract-миграция, всё прошло — шлюз отключён, ядро остановлено до
 *      миграции и поднято на новом коде;
 *   2. contract-миграция упала (не применена) — откат кода, шлюз включён
 *      обратно вместе с прежним кодом;
 *   3. contract-миграция применена, ядро не поднялось — откат запрещён;
 *   4. то же, сбой на проверке маршрутов снаружи;
 *   5. contract-миграция применена, следующая за ней упала — откат запрещён;
 *   6. contract-миграции нет, сбой — прежнее поведение: ядро не
 *      останавливается до миграции, код откатывается;
 *   7. база новее кода (выкат старого коммита) — выкат отменён до миграции;
 *   8. реестр миграций после сбоя не читается — откат запрещён (осторожно);
 *   9. на сервере нет юнита шлюза — шаг пропускается;
 *  10. M150 применена прошлым выпуском, шлюз остался отключённым юнитом,
 *      следующий выпуск падает — откат кода, шлюз НЕ включается (замечание
 *      Тэнка при приёмке W05);
 *  11. то же, но шлюз кто-то запустил руками — выпуск его гасит, откат не
 *      поднимает;
 *  12. до M150 шлюз был включён, но не запущен — откат возвращает именно это
 *      состояние, а не «включён и запущен»;
 *  13. переименование баз вместе с M150, выпуск прошёл — ядро остановлено до
 *      ALTER DATABASE, база и `.env` под новыми именами;
 *  14. переименование, M150 упала — откат возвращает и код, и имена баз, и
 *      `.env` (замечание Тэнка: прежний код и конфигурация знают прежнее имя);
 *  15. переименование, M150 применена, ядро не поднялось — откат запрещён,
 *      имена остаются новыми;
 *  16. переименование без contract-миграции, сбой — откат возвращает имена;
 *  17. база уже переименована прошлой попыткой, `.env` — нет — дописывается
 *      только `.env`;
 *  18. обе базы существуют — выпуск отменяется до остановки ядра;
 *  19. ALTER DATABASE упал — откат восстанавливает `.env`.
 *
 * Запуск: npm run check:deploy-release
 */
import { parseMigrationStatus, runRelease } from './lib/deploy-release.mjs';

const OLD = 'aaa1111';
const NEW = 'bbb2222';
const ROUTES = ['/', '/v1/health'];

const BASE = ['M148_material_counters_active_uploads', 'M149_material_quota_reservation'];
const M150 = 'M150_remove_investment_seasons_expertise_ai';
const M151 = 'M151_next_step';

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  ok    ${name}`);
  } else {
    failed += 1;
    console.error(`  СБОЙ  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Имитация сервера.
 * @param {object} o
 * @param {Record<string, string[]>} o.files    миграции в коде каждого коммита
 * @param {string[]} o.contract                 какие из них помечены contract
 * @param {string[]} o.applied                  применены в базе до выпуска
 * @param {false | { active: boolean, enabled: boolean }} [o.gateway]
 *                                             юнит шлюза: нет / его состояние
 *                                             (по умолчанию запущен и включён)
 * @param {string} [o.failMigration]            эта миграция падает
 * @param {boolean} [o.coreDown]                ядро на новом коде не отвечает
 * @param {boolean} [o.routesDown]              маршруты снаружи не отвечают
 * @param {boolean} [o.statusDownAfterMigrate]  реестр не читается после миграции
 * @param {string[]} [o.dbs]                    базы на сервере
 *                                             (по умолчанию уже новые имена)
 * @param {string} [o.envDb]                    имя основной базы в `.env`
 * @param {boolean} [o.renameFails]             ALTER DATABASE падает
 */
function makeServer(o) {
  const state = {
    commit: OLD,
    builtCommit: OLD,
    units: {
      'unicorn-core': { active: true, enabled: true, runsCommit: OLD },
      ...(o.gateway === false
        ? {}
        : {
            'unicorn-ai-gateway': {
              active: true,
              enabled: true,
              ...o.gateway,
              runsCommit: OLD,
            },
          }),
    },
    applied: [...o.applied],
    migrated: false,
    dbs: new Set(o.dbs ?? ['fifth_element', 'fifth_element_test']),
    env: {
      DATABASE_URL: o.envDb ?? 'fifth_element',
      DATABASE_URL_OWNER: o.envDb ?? 'fifth_element',
      DATABASE_URL_TEST: o.envDb === 'unicorn_launch' ? 'unicorn_test' : 'fifth_element_test',
    },
    envBackup: null,
  };
  const events = [];
  const violations = [];

  // Нарушение: сервис работает на коде, в котором нет применённой
  // contract-миграции, — то есть обращается к удалённой схеме.
  const audit = (where) => {
    for (const [name, unit] of Object.entries(state.units)) {
      if (!unit.active) continue;
      const known = new Set(o.files[unit.runsCommit] ?? []);
      const missing = state.applied.filter((id) => o.contract.includes(id) && !known.has(id));
      if (missing.length) violations.push(`${where}: ${name}@${unit.runsCommit} над ${missing}`);
      // Удалённый из кода сервис не должен работать над новой схемой вовсе.
      if (name === 'unicorn-ai-gateway' && state.applied.includes(M150)) {
        violations.push(`${where}: шлюз работает после ${M150}`);
      }
      // Ядро смотрит в базу из `.env`: её не должно не быть.
      if (name === 'unicorn-core' && !state.dbs.has(state.env.DATABASE_URL_OWNER)) {
        violations.push(`${where}: ядро смотрит в несуществующую ${state.env.DATABASE_URL_OWNER}`);
      }
    }
  };

  const fail = (cmd) => {
    const error = new Error(`remote failed: ${cmd}`);
    throw error;
  };

  function remote(cmd, { allowFail = false } = {}) {
    events.push(cmd);
    try {
      const r = exec(cmd);
      audit(cmd);
      return r;
    } catch (error) {
      audit(cmd);
      if (allowFail) return null;
      throw error;
    }
  }

  function exec(cmd) {
    let m;
    if (cmd.startsWith("grep -E '^DATABASE_URL")) {
      return Object.entries(state.env)
        .map(([k, v]) => `${k}=postgres://u:p@localhost:5432/${v}`)
        .join('\n');
    }
    if ((m = /datname = '(\w+)'"$/.exec(cmd)) && cmd.includes('SELECT 1 FROM pg_database')) {
      return state.dbs.has(m[1]) ? '1' : '';
    }
    if ((m = /ALTER DATABASE (\w+) RENAME TO (\w+)/.exec(cmd))) {
      if (state.units['unicorn-core'].active) violations.push(`${cmd}: ядро работает`);
      if (o.renameFails) fail(cmd);
      state.dbs.delete(m[1]);
      state.dbs.add(m[2]);
      return '';
    }
    if ((m = /^sed -i -E '\/\^DATABASE_URL\/ s#\/(\w+)\\b#\/(\w+)#' \.env$/.exec(cmd))) {
      for (const k of Object.keys(state.env)) if (state.env[k] === m[1]) state.env[k] = m[2];
      return '';
    }
    if (cmd === 'cp .env .env.before-db-rename') {
      state.envBackup = { ...state.env };
      return '';
    }
    if (cmd === 'cp .env.before-db-rename .env') {
      state.env = { ...state.envBackup };
      return '';
    }
    if ((m = /git reset --hard (\w+)/.exec(cmd))) {
      state.commit = m[1];
      return '';
    }
    if (cmd === 'git rev-parse --short HEAD') return state.commit;
    if (cmd === 'npm run build') {
      state.builtCommit = state.commit;
      return '';
    }
    if (cmd.startsWith('npm ci') || cmd.startsWith('npm run build:console')) return '';
    if (cmd.startsWith('npm run check:front-builds')) return '';
    if (cmd.startsWith('npm run --silent migrate:status')) {
      if (state.migrated && o.statusDownAfterMigrate) fail(cmd);
      const files = o.files[state.commit];
      const lines = files.map((id) => `  ${state.applied.includes(id) ? '✔' : ' '} ${id}`);
      const pending = files.filter((id) => !state.applied.includes(id)).length;
      return `\nПрименено: ${state.applied.length}, ожидает: ${pending}\n\n${lines.join('\n')}\n`;
    }
    if (cmd.startsWith('grep -l -E')) {
      return o.files[state.commit]
        .filter((id) => o.contract.includes(id))
        .map((id) => `database/migrations/${id}.sql`)
        .join('\n');
    }
    if ((m = /systemctl list-unit-files ([\w-]+)\.service/.exec(cmd))) {
      return state.units[m[1]] ? `${m[1]}.service enabled enabled` : '';
    }
    if ((m = /systemctl is-active ([\w-]+)/.exec(cmd))) {
      return state.units[m[1]]?.active ? 'active' : 'inactive';
    }
    if ((m = /systemctl is-enabled ([\w-]+)/.exec(cmd))) {
      return state.units[m[1]]?.enabled ? 'enabled' : 'disabled';
    }
    if ((m = /systemctl stop ([\w-]+) && systemctl disable ([\w-]+)/.exec(cmd))) {
      Object.assign(state.units[m[1]], { active: false, enabled: false });
      return '';
    }
    if ((m = /^systemctl enable ([\w-]+) --quiet$/.exec(cmd))) {
      state.units[m[1]].enabled = true;
      return '';
    }
    if ((m = /^systemctl start ([\w-]+)$/.exec(cmd))) {
      Object.assign(state.units[m[1]], { active: true, runsCommit: state.builtCommit });
      return '';
    }
    if ((m = /^systemctl stop ([\w-]+)$/.exec(cmd))) {
      state.units[m[1]].active = false;
      return '';
    }
    if ((m = /^systemctl restart ([\w-]+)$/.exec(cmd))) {
      Object.assign(state.units[m[1]], { active: true, runsCommit: state.builtCommit });
      return '';
    }
    if (cmd === 'npm run db:migrate') {
      state.migrated = true;
      for (const id of o.files[state.commit]) {
        if (state.applied.includes(id)) continue;
        if (id === o.failMigration) fail(cmd);
        state.applied.push(id);
        audit(`после ${id}`);
      }
      return '';
    }
    if (cmd.startsWith('npm run bootstrap:roles')) return '';
    if (cmd.includes('/v1/health')) {
      return o.coreDown && state.units['unicorn-core'].runsCommit === NEW ? '000' : '200';
    }
    if (cmd.startsWith('npm run web:up') || cmd.startsWith('docker exec')) return '';
    throw new Error(`имитация не знает команды: ${cmd}`);
  }

  const probe = (url) => {
    if (url.endsWith('/console/')) return 403;
    return o.routesDown && state.units['unicorn-core'].runsCommit === NEW ? 502 : 200;
  };
  const quiet = () => undefined;
  const ops = {
    remote,
    probe,
    sleep: quiet,
    log: { step: quiet, ok: quiet, info: quiet, fail: quiet },
  };
  return { ops, state, events, violations };
}

function run(name, o) {
  console.warn(`\n▸ ${name}`);
  const server = makeServer(o);
  const result = runRelease({
    ops: server.ops,
    before: OLD,
    head: NEW,
    publicUrl: 'https://stand.test',
    routes: ROUTES,
  });
  return { ...server, result };
}

const idx = (events, re) => events.findIndex((e) => re.test(e));
const W05 = { [OLD]: BASE, [NEW]: [...BASE, M150] };

// --- разбор вывода раннера -----------------------------------------------------
console.warn('\n▸ разбор migrate:status');
{
  const parsed = parseMigrationStatus(
    `\nПрименено: 3, ожидает: 1\n\n  ✔ ${BASE[0]}\n  ✔ ${BASE[1]}\n    ${M150}\n`,
  );
  check('применённые прочитаны', parsed.applied.join() === BASE.join());
  check('ожидающие прочитаны', parsed.pending.join() === M150);
  check('применённые без файла в коде посчитаны', parsed.unknownApplied === 1);
  let threw = false;
  try {
    parseMigrationStatus('ОШИБКА МИГРАЦИИ: нет соединения');
  } catch {
    threw = true;
  }
  check('непонятный вывод — ошибка, а не «нечего применять»', threw);
}

// --- 1 --------------------------------------------------------------------------
{
  const s = run('1. contract-миграция, выпуск прошёл', {
    files: W05,
    contract: [M150],
    applied: BASE,
  });
  check('выпуск завершён', s.result.outcome === 'released', s.result.outcome);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
  const migrate = idx(s.events, /^npm run db:migrate$/);
  const stopCore = idx(s.events, /^systemctl stop unicorn-core$/);
  const stopGw = idx(s.events, /systemctl stop unicorn-ai-gateway && systemctl disable/);
  check('ядро остановлено до миграции', stopCore >= 0 && stopCore < migrate);
  check('шлюз остановлен и отключён до миграции', stopGw >= 0 && stopGw < migrate);
  check('ядро работает на новом коде', s.state.units['unicorn-core'].runsCommit === NEW);
  const gw = s.state.units['unicorn-ai-gateway'];
  check('шлюз не работает и не поднимется после перезагрузки', !gw.active && !gw.enabled);
}

// --- 2 --------------------------------------------------------------------------
{
  const s = run('2. contract-миграция упала и не применена', {
    files: W05,
    contract: [M150],
    applied: BASE,
    failMigration: M150,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
  check('M150 не применена', !s.state.applied.includes(M150));
  check('код на прежнем коммите', s.state.commit === OLD);
  check('ядро работает на прежнем коде', s.state.units['unicorn-core'].runsCommit === OLD);
  check('ядро поднято', s.state.units['unicorn-core'].active);
  const gw = s.state.units['unicorn-ai-gateway'];
  check('шлюз включён обратно вместе с прежним кодом', gw.active && gw.enabled);
}

// --- 3 --------------------------------------------------------------------------
{
  const s = run('3. M150 применена, ядро не поднялось', {
    files: W05,
    contract: [M150],
    applied: BASE,
    coreDown: true,
  });
  check('выпуск остановлен, откат запрещён', s.result.outcome === 'held', s.result.outcome);
  check('в отчёте названа M150', s.result.contractApplied.join() === M150);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
  check(
    'код не откатывался',
    s.state.commit === NEW && !s.events.some((e) => e.includes(`reset --hard ${OLD}`)),
  );
  check('ядро не запускалось на прежнем коде', s.state.units['unicorn-core'].runsCommit !== OLD);
  const gw = s.state.units['unicorn-ai-gateway'];
  check('шлюз остаётся отключён', !gw.active && !gw.enabled);
}

// --- 4 --------------------------------------------------------------------------
{
  const s = run('4. M150 применена, маршруты снаружи не отвечают', {
    files: W05,
    contract: [M150],
    applied: BASE,
    routesDown: true,
  });
  check('откат запрещён', s.result.outcome === 'held', s.result.outcome);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
  check('код не откатывался', s.state.commit === NEW);
}

// --- 5 --------------------------------------------------------------------------
{
  const s = run('5. M150 применена, следующая миграция упала', {
    files: { [OLD]: BASE, [NEW]: [...BASE, M150, M151] },
    contract: [M150],
    applied: BASE,
    failMigration: M151,
  });
  check('откат запрещён', s.result.outcome === 'held', s.result.outcome);
  check(
    'M150 применена, M151 — нет',
    s.state.applied.includes(M150) && !s.state.applied.includes(M151),
  );
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
  check('код не откатывался', s.state.commit === NEW);
}

// --- 6 --------------------------------------------------------------------------
{
  const s = run('6. contract-миграции нет, сбой после миграции', {
    files: { [OLD]: BASE, [NEW]: [...BASE, M151] },
    contract: [],
    applied: BASE,
    gateway: false,
    coreDown: true,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  check(
    'ядро не останавливалось до миграции',
    idx(s.events, /^systemctl stop unicorn-core$/) === -1,
  );
  check('ядро работает на прежнем коде', s.state.units['unicorn-core'].runsCommit === OLD);
}

// --- 7 --------------------------------------------------------------------------
{
  const s = run('7. база новее кода (выкат старого коммита)', {
    files: { [OLD]: [...BASE, M150], [NEW]: BASE },
    contract: [M150],
    applied: [...BASE, M150],
    gateway: false,
  });
  check('выкат не завершён', s.result.outcome !== 'released', s.result.outcome);
  check('миграция не запускалась', idx(s.events, /^npm run db:migrate$/) === -1);
  check(
    'ядро не перезапускалось на коде без M150',
    !s.events.some((e) => e === 'systemctl restart unicorn-core') ||
      s.state.units['unicorn-core'].runsCommit === OLD,
  );
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 8 --------------------------------------------------------------------------
{
  const s = run('8. после сбоя реестр миграций не читается', {
    files: W05,
    contract: [M150],
    applied: BASE,
    coreDown: true,
    statusDownAfterMigrate: true,
  });
  check('откат запрещён по осторожности', s.result.outcome === 'held', s.result.outcome);
  check('код не откатывался', s.state.commit === NEW);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 9 --------------------------------------------------------------------------
{
  const s = run('9. юнита шлюза на сервере нет', {
    files: W05,
    contract: [M150],
    applied: BASE,
    gateway: false,
  });
  check('выпуск завершён', s.result.outcome === 'released', s.result.outcome);
  check(
    'шлюз не трогали',
    !s.events.some((e) => /systemctl (stop|disable|enable) unicorn-ai-gateway/.test(e)),
  );
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

const OLD_NAMES = { dbs: ['unicorn_launch', 'unicorn_test'], envDb: 'unicorn_launch' };
const namesOld = (s) =>
  s.state.dbs.has('unicorn_launch') &&
  !s.state.dbs.has('fifth_element') &&
  s.state.env.DATABASE_URL_OWNER === 'unicorn_launch' &&
  s.state.env.DATABASE_URL_TEST === 'unicorn_test';
const namesNew = (s) =>
  s.state.dbs.has('fifth_element') &&
  s.state.dbs.has('fifth_element_test') &&
  !s.state.dbs.has('unicorn_launch') &&
  s.state.env.DATABASE_URL_OWNER === 'fifth_element' &&
  s.state.env.DATABASE_URL_TEST === 'fifth_element_test';

const W05_DONE = { [OLD]: [...BASE, M150], [NEW]: [...BASE, M150, M151] };

// --- 10 -------------------------------------------------------------------------
{
  const s = run('10. M150 применена раньше, шлюз отключён, следующий выпуск упал', {
    files: W05_DONE,
    contract: [M150],
    applied: [...BASE, M150],
    gateway: { active: false, enabled: false },
    coreDown: true,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  const gw = s.state.units['unicorn-ai-gateway'];
  check('шлюз не запущен', !gw.active);
  check('шлюз не включён', !gw.enabled);
  check(
    'шлюзу не отдавали команд enable/start',
    !s.events.some((e) => /systemctl (enable|start) unicorn-ai-gateway/.test(e)),
  );
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 11 -------------------------------------------------------------------------
{
  const s = run('11. M150 применена раньше, шлюз запущен руками, выпуск упал', {
    files: W05_DONE,
    contract: [M150],
    applied: [...BASE, M150],
    gateway: { active: true, enabled: true },
    coreDown: true,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  const gw = s.state.units['unicorn-ai-gateway'];
  check('шлюз остановлен и остаётся отключён', !gw.active && !gw.enabled);
  // Шлюз работал над M150 ещё ДО выпуска — это состояние, которое выпуск
  // застал, а не создал. Важно, что после остановки его никто не поднимает.
  const stopped = s.events.findIndex((e) =>
    /systemctl stop unicorn-ai-gateway && systemctl disable/.test(e),
  );
  check(
    'после остановки шлюзу не отдавали enable/start',
    stopped >= 0 &&
      !s.events
        .slice(stopped + 1)
        .some((e) => /systemctl (enable|start) unicorn-ai-gateway/.test(e)),
  );
}

// --- 12 -------------------------------------------------------------------------
{
  const s = run('12. до M150 шлюз включён, но не запущен; выпуск упал', {
    files: W05,
    contract: [M150],
    applied: BASE,
    gateway: { active: false, enabled: true },
    failMigration: M150,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  const gw = s.state.units['unicorn-ai-gateway'];
  check('шлюз снова включён, как был', gw.enabled);
  check('шлюз не запущен, как был', !gw.active);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 13 -------------------------------------------------------------------------
{
  const s = run('13. переименование баз вместе с M150, выпуск прошёл', {
    files: W05,
    contract: [M150],
    applied: BASE,
    ...OLD_NAMES,
  });
  check('выпуск завершён', s.result.outcome === 'released', s.result.outcome);
  check('базы и .env под новыми именами', namesNew(s), JSON.stringify(s.state.env));
  const stop = idx(s.events, /^systemctl stop unicorn-core$/);
  const alter = idx(s.events, /ALTER DATABASE unicorn_launch RENAME/);
  check('ядро остановлено до ALTER DATABASE', stop >= 0 && stop < alter);
  check('.env сохранён до правки', idx(s.events, /^cp \.env \.env\.before/) < alter);
  check('ядро работает на новом коде', s.state.units['unicorn-core'].runsCommit === NEW);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 14 -------------------------------------------------------------------------
{
  const s = run('14. переименование, M150 упала', {
    files: W05,
    contract: [M150],
    applied: BASE,
    failMigration: M150,
    ...OLD_NAMES,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  check('базы и .env под прежними именами', namesOld(s), JSON.stringify(s.state.env));
  check(
    'ядро на прежнем коде и поднято',
    s.state.units['unicorn-core'].runsCommit === OLD && s.state.units['unicorn-core'].active,
  );
  const back = idx(s.events, /ALTER DATABASE fifth_element RENAME TO unicorn_launch/);
  const reset = idx(s.events, new RegExp(`git reset --hard ${OLD}`));
  check('имя возвращено до сброса кода', back >= 0 && back < reset);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 15 -------------------------------------------------------------------------
{
  const s = run('15. переименование, M150 применена, ядро не поднялось', {
    files: W05,
    contract: [M150],
    applied: BASE,
    coreDown: true,
    ...OLD_NAMES,
  });
  check('откат запрещён', s.result.outcome === 'held', s.result.outcome);
  check('имена остаются новыми', namesNew(s), JSON.stringify(s.state.env));
  check('код не откатывался', s.state.commit === NEW);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 16 -------------------------------------------------------------------------
{
  const s = run('16. переименование без contract-миграции, сбой', {
    files: W05_DONE,
    contract: [M150],
    applied: [...BASE, M150],
    gateway: false,
    coreDown: true,
    ...OLD_NAMES,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  check('базы и .env под прежними именами', namesOld(s), JSON.stringify(s.state.env));
  check(
    'ядро остановлено до ALTER DATABASE',
    idx(s.events, /^systemctl stop unicorn-core$/) < idx(s.events, /ALTER DATABASE unicorn_launch/),
  );
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

// --- 17 -------------------------------------------------------------------------
{
  const s = run('17. база переименована прошлой попыткой, .env — нет', {
    files: W05_DONE,
    contract: [M150],
    applied: [...BASE, M150],
    gateway: false,
    dbs: ['fifth_element', 'fifth_element_test'],
    envDb: 'unicorn_launch',
  });
  check('выпуск завершён', s.result.outcome === 'released', s.result.outcome);
  check('базы и .env под новыми именами', namesNew(s), JSON.stringify(s.state.env));
  check('ALTER DATABASE не выполнялся', idx(s.events, /ALTER DATABASE/) === -1);
}

// --- 18 -------------------------------------------------------------------------
{
  const s = run('18. обе базы существуют', {
    files: W05_DONE,
    contract: [M150],
    applied: [...BASE, M150],
    gateway: false,
    dbs: ['unicorn_launch', 'unicorn_test', 'fifth_element', 'fifth_element_test'],
    envDb: 'unicorn_launch',
  });
  check('выпуск не завершён', s.result.outcome !== 'released', s.result.outcome);
  check('ALTER DATABASE не выполнялся', idx(s.events, /ALTER DATABASE/) === -1);
  check('миграция не запускалась', idx(s.events, /^npm run db:migrate$/) === -1);
  check('.env не тронут', s.state.env.DATABASE_URL_OWNER === 'unicorn_launch');
}

// --- 19 -------------------------------------------------------------------------
{
  const s = run('19. ALTER DATABASE упал', {
    files: W05_DONE,
    contract: [M150],
    applied: [...BASE, M150],
    gateway: false,
    renameFails: true,
    ...OLD_NAMES,
  });
  check('код откатан', s.result.outcome === 'rolled-back', s.result.outcome);
  check('базы и .env под прежними именами', namesOld(s), JSON.stringify(s.state.env));
  check('ядро поднято', s.state.units['unicorn-core'].active);
  check('нарушений нет', s.violations.length === 0, s.violations.join('; '));
}

console.warn(`\nИтог: ${passed} пройдено, ${failed} провалено.\n`);
process.exit(failed ? 1 : 0);
