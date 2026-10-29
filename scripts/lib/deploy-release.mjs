/**
 * Выпуск на сервере: код, сборка, база, перезапуск, проверка — и что делать
 * при сбое. Вынесен из `deploy.mjs`, чтобы порядок шагов и решение об откате
 * можно было проверить без сервера (`scripts/check-deploy-release.mjs`):
 * все обращения к серверу идут через переданные `ops`.
 *
 * Два правила, ради которых модуль написан (2.1-W05, M150):
 *
 *  1. Contract-миграция (`-- migrate:contract`) удаляет схему, с которой
 *     работает прежний код. Поэтому перед ней ядро ОСТАНАВЛИВАЕТСЯ — вместе с
 *     фоновыми обработчиками, которые живут в его процессе (`background/`), —
 *     и поднимается уже на новом коде. Окно «старое ядро над новой схемой»
 *     не возникает.
 *  2. После применённой contract-миграции код НЕ откатывается: прежний коммит
 *     обратился бы к удалённым таблицам. Выпуск останавливается и требует
 *     решения человека — исправить вперёд или восстановить базу из дампа
 *     вместе с кодом. Применена ли миграция, выясняется повторным чтением
 *     реестра, а не предположением: раннер применяет каждую миграцию в своей
 *     транзакции, и упавшая миграция не применена.
 *
 * Сервисы, удалённые из кода (AI-шлюз), останавливаются и отключаются до
 * миграции: оставленный включённым, он поднялся бы после перезагрузки сервера
 * над схемой, которой у него больше нет. При откате сервис возвращается в то
 * состояние, в котором был до выпуска, и только если база ещё совместима с
 * ним: после миграции, удалившей его схему, он не включается никогда — ни в
 * этом выпуске, ни при сбое любого следующего.
 */

/**
 * systemd-сервисы, которых больше нет в коде, и миграция, после которой им
 * не с чем работать. Останавливаются и отключаются; после этой миграции не
 * восстанавливаются.
 */
export const RETIRED_UNITS = {
  'unicorn-ai-gateway': 'M150_remove_investment_seasons_expertise_ai',
};

const CORE_UNIT = 'unicorn-core';
const CONTRACT_MARKER_GREP = "'^[[:space:]]*--[[:space:]]*migrate:contract[[:space:]]*$'";

/**
 * Разбор вывода `migrate:status`: «Применено: N, ожидает: M» и строки
 * «  ✔ M149_…» / «    M150_…». Применённые миграции, файлов которых нет в
 * коде, раннер не перечисляет — их число видно по разнице с «Применено».
 */
export function parseMigrationStatus(text) {
  const summary = /Применено:\s*(\d+),\s*ожидает:\s*(\d+)/.exec(text);
  if (!summary) throw new Error('не удалось прочитать состояние миграций');
  const applied = [];
  const pending = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(✔)?\s*(M\d{3}\S*)\s*$/.exec(line);
    if (!m) continue;
    (m[1] ? applied : pending).push(m[2]);
  }
  const appliedCount = Number(summary[1]);
  return { applied, pending, unknownApplied: appliedCount - applied.length };
}

function readStatus(ops) {
  return parseMigrationStatus(ops.remote('npm run --silent migrate:status -w database 2>&1'));
}

function contractMigrations(ops) {
  const out = ops.remote(`grep -l -E ${CONTRACT_MARKER_GREP} database/migrations/*.sql || true`);
  return new Set(
    (out || '')
      .split(/\r?\n/)
      .map((p) =>
        p
          .trim()
          .replace(/^.*\//, '')
          .replace(/\.sql$/, ''),
      )
      .filter(Boolean),
  );
}

function unitExists(ops, unit) {
  return Boolean(ops.remote(`systemctl list-unit-files ${unit}.service --no-legend || true`));
}

function unitState(ops, unit) {
  return {
    active: ops.remote(`systemctl is-active ${unit} || true`),
    enabled: ops.remote(`systemctl is-enabled ${unit} || true`),
  };
}

/**
 * @param {object} p
 * @param {{ remote: Function, probe: Function, sleep: Function,
 *           log: { step: Function, ok: Function, info: Function, fail: Function } }} p.ops
 * @returns {{ outcome: 'released' | 'rolled-back' | 'rollback-failed' | 'held',
 *             contractApplied: string[] }}
 */
export function runRelease({ ops, before, head, publicUrl, routes }) {
  const { remote, probe, sleep, log } = ops;
  let pendingContract = [];
  const retired = [];

  try {
    log.step('Код и сборка');
    remote(`git fetch origin main --quiet && git reset --hard ${head} --quiet`);
    log.ok(`код на ${remote('git rev-parse --short HEAD')}`);

    log.info('npm ci — займёт минуту');
    remote('npm ci --no-audit --no-fund', { show: true });

    log.info('сборка пакетов и фронтендов');
    remote('npm run build', { show: true });
    // Консоль собирается отдельной командой намеренно: `npm run build` её не
    // трогает, чтобы она не уезжала туда, где не нужна. Здесь нужна — доступ к
    // ней закрыт привратником, а не отсутствием файлов.
    remote('npm run build:console', { show: true });
    // Фронты обязаны быть production-сборкой: отладочный React удваивает запросы
    // (StrictMode) и тянет предупреждения в консоль (этап 5.6.4д).
    remote('npm run check:front-builds', { show: true });
    log.ok('собрано, сборки production');

    log.step('План базы');
    const status = readStatus(ops);
    // База знает миграции, которых нет в выкатываемом коде: код старее схемы.
    // Так бывает при выкате старого коммита — это тот же несовместимый откат.
    if (status.unknownApplied > 0) {
      throw new Error(
        `в базе применено ${status.unknownApplied} миграций, которых нет в ${head} — ` +
          'код старее схемы, выкат отменён',
      );
    }
    const contract = contractMigrations(ops);
    pendingContract = status.pending.filter((id) => contract.has(id));
    log.ok(
      `ожидает миграций: ${status.pending.length}` +
        (pendingContract.length ? `, из них contract: ${pendingContract.join(', ')}` : ''),
    );

    // Исходное состояние запоминается до любых действий: откат возвращает
    // именно его, а не «включено и запущено».
    for (const [unit, retiredBy] of Object.entries(RETIRED_UNITS)) {
      if (!unitExists(ops, unit)) continue;
      const state = unitState(ops, unit);
      const entry = {
        unit,
        retiredBy,
        wasActive: state.active === 'active',
        wasEnabled: state.enabled === 'enabled',
      };
      if (entry.wasActive || entry.wasEnabled) retired.push(entry);
    }
    if (retired.length) {
      log.step('Удалённые сервисы');
      for (const { unit } of retired) {
        remote(`systemctl stop ${unit} && systemctl disable ${unit} --quiet`);
        const state = unitState(ops, unit);
        if (state.active === 'active' || state.enabled === 'enabled') {
          throw new Error(`${unit} не остановился (${state.active}, ${state.enabled})`);
        }
        log.ok(`${unit} остановлен и отключён`);
      }
    }

    if (pendingContract.length) {
      log.step('Остановка ядра перед contract-миграцией');
      remote(`systemctl stop ${CORE_UNIT}`);
      const state = unitState(ops, CORE_UNIT);
      if (state.active === 'active') throw new Error('ядро не остановилось — миграция отменена');
      log.ok('ядро и его фоновые обработчики остановлены');
    }

    log.step('База');
    remote('npm run db:migrate', { show: true });
    remote('npm run bootstrap:roles -w database', { show: true });
    log.ok('миграции и роли применены');

    log.step('Перезапуск');
    remote(`systemctl restart ${CORE_UNIT}`);

    // Ядру нужно время подняться: сразу после restart оно ещё не слушает порт,
    // а следом идёт проверка конфигурации nginx, которая ходит именно в него.
    let coreUp = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      sleep(3000);
      if (
        remote('curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:4300/v1/health', {
          allowFail: true,
        }) === '200'
      ) {
        coreUp = true;
        break;
      }
    }
    if (!coreUp) throw new Error('ядро не поднялось после перезапуска');
    log.ok('ядро отвечает');

    remote('npm run web:up', { show: true });

    // compose НЕ пересоздаёт контейнер, если его определение не менялось, —
    // а конфиг nginx лежит в смонтированном каталоге и меняется вместе с кодом.
    // nginx же читает конфигурацию только при старте. Без явного reload новый
    // console.conf приехал бы файлом, но не применился: ровно так 2026-09-13
    // консоль осталась открытой при обновлённом коде.
    const confOk = remote('docker exec unicorn-web nginx -t', { allowFail: true });
    if (confOk === null)
      throw new Error('конфигурация nginx не проходит проверку — reload отменён');
    remote('docker exec unicorn-web nginx -s reload');
    log.ok('ядро и прокси подняты, конфигурация nginx перечитана');

    log.step('Проверка снаружи');
    let bad = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      bad = routes.filter((r) => probe(`${publicUrl}${r}`) !== 200);
      if (bad.length === 0) break;
      sleep(5000);
    }
    if (bad.length > 0) throw new Error(`не отвечают: ${bad.join(', ')}`);
    log.ok(`все ${routes.length} маршрутов отвечают 200`);

    // Консоль обязана быть закрыта анониму: это и проверяем снаружи, а не
    // верим конфигурации.
    const consoleCode = probe(`${publicUrl}/console/`);
    if (consoleCode === 200) {
      throw new Error('/console/ открыта анониму — привратник не работает');
    }
    log.ok(`/console/ закрыта анониму (${consoleCode})`);
    return { outcome: 'released', contractApplied: [] };
  } catch (error) {
    log.fail(error instanceof Error ? error.message : String(error));
    return recover({ ops, before, routes, publicUrl, pendingContract, retired });
  }
}

function recover({ ops, before, routes, publicUrl, pendingContract, retired }) {
  const { remote, probe, log } = ops;

  // Применена ли contract-миграция — спрашиваем базу. Не смогли спросить —
  // считаем применённой: ошибочный запрет отката стоит простоя, ошибочный
  // откат — работы старого кода над удалённой схемой.
  //
  // Реестр читается ОДИН раз и до сброса кода: раннер перечисляет только
  // миграции, файлы которых есть в коде, и после `git reset` на прежний коммит
  // применённая M150 из списка пропала бы.
  let now = null;
  try {
    now = readStatus(ops);
  } catch {
    log.fail('состояние миграций прочитать не удалось — считаю contract-миграцию применённой');
  }
  const contractApplied = now
    ? pendingContract.filter((id) => now.applied.includes(id))
    : pendingContract;

  if (contractApplied.length) {
    log.step('Откат кода запрещён');
    log.fail(
      `применены contract-миграции ${contractApplied.join(', ')}: код ${before} обращается ` +
        'к удалённой схеме и на этой базе не работает',
    );
    log.info('код оставлен на новом коммите, удалённые сервисы остаются отключены');
    log.info('дальше решает человек: исправить вперёд новым коммитом');
    log.info('или восстановить базу из дампа и вернуть код вместе с ней — вручную');
    return { outcome: 'held', contractApplied };
  }

  log.step('Откат кода');
  try {
    remote(`git reset --hard ${before} --quiet`);
    remote('npm ci --no-audit --no-fund', { show: true });
    remote('npm run build', { show: true });
    remote('npm run build:console', { show: true });
    remote(`systemctl restart ${CORE_UNIT}`);
    restoreRetired(ops, retired, now);
    remote('npm run web:up', { show: true });
    const back = routes.filter((r) => probe(`${publicUrl}${r}`) !== 200);
    if (back.length === 0) log.ok(`откатились на ${before}, стенд отвечает`);
    else log.fail(`откатились на ${before}, но стенд отвечает не полностью: ${back.join(', ')}`);
    return { outcome: 'rolled-back', contractApplied: [] };
  } catch {
    log.fail('ОТКАТ НЕ УДАЛСЯ — стенд требует ручного вмешательства');
    return { outcome: 'rollback-failed', contractApplied: [] };
  }
}

/**
 * Вернуть удалённые сервисы в состояние до выпуска — только те, которые этот
 * выпуск сам остановил, и только пока база не прошла миграцию, удалившую их
 * схему. Реестр не прочитан или в базе есть миграции, неизвестные коду, —
 * не восстанавливаем: отключённый шлюз стоит функции, включённый над чужой
 * схемой — ошибок в работающей системе.
 */
function restoreRetired(ops, retired, status) {
  if (!retired.length) return;
  const { remote, log } = ops;
  for (const { unit, retiredBy, wasActive, wasEnabled } of retired) {
    if (!status || status.unknownApplied > 0 || status.applied.includes(retiredBy)) {
      log.info(`${unit} остаётся отключён: ${retiredBy} применена или это не установить`);
      continue;
    }
    if (wasEnabled) remote(`systemctl enable ${unit} --quiet`);
    if (wasActive) remote(`systemctl start ${unit}`);
    log.info(`${unit} возвращён в прежнее состояние вместе с прежним кодом`);
  }
}
