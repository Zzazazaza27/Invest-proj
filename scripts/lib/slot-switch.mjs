/**
 * Переключение слотов ядра (блок 09, задание 3; уточнения Тэнка 09.11).
 *
 * Порядок и пути отказа — здесь; действия над средой (контейнеры, файлы, nginx, запросы)
 * приходят портом `ops`: так одна логика служит рабочей и тестовым средам и проверяется
 * без Docker (scripts/check-slot-switch.mjs).
 *
 *  1. Кандидат в свободном слоте, без фона (разрешения нет). Готовность и проверки — в его
 *     порт, мимо nginx. Отказ — кандидат остановлен, маршрут не тронут.
 *  2. Разрешение фона снимается (owner=null) ДО паузы: перезапуск старого слота после паузы
 *     её не отменит. Пауза старого — до `paused` (все проходы закончились). Не дошла —
 *     разрешение старому, продолжение, кандидат остановлен.
 *  3. Файл маршрута → nginx -t и мягкая перезагрузка. Отказ — прежний маршрут, разрешение и
 *     продолжение старого.
 *  4. Подтверждение запросом через nginx: каждый из N ответов — сборка и слот кандидата.
 *     Нет — прежний маршрут, подтверждение прежней сборкой, фон старого.
 *  5. Разрешение фона кандидату и продолжение — только после подтверждения.
 *  6. Наблюдение. Отказ — возврат по разрешённому плану (`autoRollback`), иначе остановка
 *     с решением за Томасом: кандидат продолжает обслуживать, старый жив без фона.
 *  7. Старый слот останавливается, когда старые обработчики nginx его не используют и
 *     активных запросов нет; срок вышел — явный порядок: число оборванных в журнал, SIGTERM.
 *
 * Каждый шаг пишется в журнал (`ops.record`) до и после: после обрыва фактическое состояние
 * восстанавливается сверкой (`factualState`), а не повтором вслепую.
 */

const DEFAULTS = {
  readyWaitMs: 120_000,
  confirmSamples: 5,
  confirmWaitMs: 15_000,
  stopWaitMs: 60_000,
  confirmIntervalMs: 200,
  observeMs: 600_000,
  drainWaitMs: 300_000,
  pollMs: 2_000,
};

/**
 * @returns {Promise<{ ok: boolean, stage: string, detail: string, active: string }>}
 *   `active` — слот, который обслуживает запросы по итогу.
 */
export async function switchSlots(ops, plan) {
  const o = { ...DEFAULTS, ...plan.limits };
  const { from, to, build, prevBuild, autoRollback = false } = plan;
  const say = (stage, status, detail = '') => ops.record(stage, status, detail);
  const until = async (check, ms) => {
    const end = ops.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (ops.now() >= end) return false;
      await ops.sleep(o.pollMs);
    }
  };

  // Вернуть всё старому слоту: маршрут, подтверждение, разрешение и фон, кандидат остановлен.
  const backToOld = async (stage, why, { routeChanged }) => {
    say(stage, 'fail', why);
    if (routeChanged) {
      ops.writeRoute({ slot: from, build: prevBuild, prevBuild });
      const reload = await ops.reloadNginx();
      const back = reload.ok && (await confirmed(from, prevBuild));
      say('route-back', back ? 'ok' : 'fail', reload.ok ? '' : reload.detail);
      if (!back) {
        // Ни кандидат, ни прежний не подтверждены — дальше только человек; фон не трогаем.
        return {
          ok: false,
          stage: 'route-back',
          detail: `${why}; прежний маршрут не подтверждён`,
          active: 'unknown',
        };
      }
    }
    // Кандидат останавливается ДО возобновления фона старого, и остановка подтверждается:
    // незавершённый проход кандидата не должен пересечься с фоном старого (Тэнк, 09.11).
    // Пауза кандидата (`pausing`) этого не доказывает — доказывает остановленный процесс.
    await ops.stopSlot(to);
    const stopped = await until(async () => (await ops.slotStopped(to)) === true, o.stopWaitMs);
    say('stop-candidate', stopped ? 'ok' : 'fail', stopped ? '' : 'остановка не подтверждена');
    if (!stopped) {
      return {
        ok: false,
        stage: 'stop-candidate',
        detail: `${why}; кандидат не остановлен — фон старого не возобновлён, решение за Томасом`,
        active: from,
      };
    }
    ops.writeGrant(from);
    const mode = await ops.resume(from);
    say('resume-old', mode === 'running' ? 'ok' : 'fail', mode);
    return { ok: false, stage, detail: why, active: from };
  };

  // Подтверждение: N ответов подряд от ожидаемого слота и сборки по НОВЫМ соединениям
  // (viaNginx не переиспользует соединение). Сразу после мягкой перезагрузки старые
  // обработчики nginx ещё дорабатывают — ждём до предела, а не судим по первому ответу.
  // Испытание 09.11: запрос по прежнему keep-alive видел старое ядро, и переключение
  // ошибочно считалось неподтверждённым.
  const confirmed = async (slot, expectBuild) => {
    let streak = 0;
    const end = ops.now() + o.confirmWaitMs;
    while (ops.now() <= end) {
      const r = await ops.viaNginx().catch(() => ({}));
      streak = r.slot === slot && r.build === expectBuild ? streak + 1 : 0;
      if (streak >= o.confirmSamples) return true;
      await ops.sleep(o.confirmIntervalMs);
    }
    return false;
  };

  // 1. Кандидат.
  say('candidate', 'start', `${to} сборки ${build}`);
  await ops.startCandidate(to, build);
  if (!(await until(() => ops.ready(to), o.readyWaitMs))) {
    await ops.stopSlot(to);
    say('candidate', 'fail', 'не готов к сроку');
    return { ok: false, stage: 'candidate', detail: 'кандидат не готов', active: from };
  }
  const checks = await ops.candidateChecks(to);
  if (!checks.ok) {
    await ops.stopSlot(to);
    say('candidate', 'fail', checks.detail);
    return {
      ok: false,
      stage: 'candidate',
      detail: `проверки кандидата: ${checks.detail}`,
      active: from,
    };
  }
  say('candidate', 'ok');

  // 2. Пауза фона старого — разрешение снимается до неё.
  ops.writeGrant(null);
  say('grant', 'ok', 'owner=null');
  const paused = await ops.pause(from);
  if (paused !== 'paused') {
    return backToOld('pause', `фон старого не на паузе: ${paused}`, { routeChanged: false });
  }
  say('pause', 'ok');

  // 3. Маршрут.
  ops.writeRoute({ slot: to, build, prevBuild });
  say('route', 'written', `${to} ${build}`);
  const reload = await ops.reloadNginx();
  if (!reload.ok) {
    // Прежний файл маршрута — до разбора: новый nginx не принял, работает прежняя конфигурация.
    ops.writeRoute({ slot: from, build: prevBuild, prevBuild });
    return backToOld('reload', `перезагрузка nginx: ${reload.detail}`, { routeChanged: false });
  }
  say('reload', 'ok');

  // 4. Подтверждение запросом.
  if (!(await confirmed(to, build))) {
    return backToOld('confirm', 'через nginx отвечает не кандидат', { routeChanged: true });
  }
  say('confirm', 'ok');

  // 5. Фон кандидату — только теперь.
  ops.writeGrant(to);
  const resumed = await ops.resume(to);
  say('grant', resumed === 'running' ? 'ok' : 'fail', `owner=${to}, фон ${resumed}`);
  if (resumed !== 'running') {
    // Фон кандидата не запустился — выпуск не успешен: всё возвращается старому (Тэнк, 09.11).
    ops.writeGrant(null);
    return backToOld('grant', `фон кандидата не запустился: ${resumed}`, { routeChanged: true });
  }

  // 6. Наблюдение.
  const watch = await ops.observe(o.observeMs);
  if (!watch.ok) {
    if (!autoRollback) {
      say('observe', 'fail', `${watch.detail}; возврат не разрешён планом — решение за Томасом`);
      return { ok: false, stage: 'observe', detail: watch.detail, active: to };
    }
    ops.writeGrant(null);
    const p = await ops.pause(to);
    say('pause-candidate', p === 'paused' ? 'ok' : 'fail', p);
    return backToOld('observe', watch.detail, { routeChanged: true });
  }
  say('observe', 'ok');

  // 7. Завершение старого — по доказательству, а не по времени. Не прочитано (null) —
  // неизвестно, а не ноль: ждём до срока, затем принудительная остановка с причиной.
  const read = async (fn) => {
    try {
      const v = await fn();
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };
  const drained = await until(
    async () =>
      (await read(() => ops.nginxOldWorkers())) === 0 &&
      (await read(() => ops.activeRequests(from))) === 0,
    o.drainWaitMs,
  );
  if (!drained) {
    const left = await read(() => ops.activeRequests(from));
    const workers = await read(() => ops.nginxOldWorkers());
    say(
      'drain',
      'timeout',
      `незавершённых запросов ${left ?? 'неизвестно'}, старых обработчиков nginx ${workers ?? 'неизвестно'} — остановка по сроку`,
    );
  } else {
    say('drain', 'ok');
  }
  await ops.stopSlot(from);
  say('stop-old', 'ok');
  return {
    ok: true,
    stage: 'done',
    detail: drained ? '' : 'старое ядро остановлено по сроку',
    active: to,
  };
}

/**
 * Фактическое состояние после обрыва команды: что в файле маршрута, кто отвечает через
 * nginx, у кого разрешение и какой фон в каждом слоте. Решение о продолжении — по нему.
 */
export async function factualState(ops, slots = ['core-a', 'core-b']) {
  const route = ops.readRoute();
  const grant = ops.readGrant();
  const via = await ops.viaNginx().catch((e) => ({ error: e.message }));
  const background = {};
  for (const slot of slots)
    background[slot] = await ops.backgroundMode(slot).catch(() => 'нет ответа');
  const running = Object.entries(background)
    .filter(([, m]) => m === 'running')
    .map(([s]) => s);
  return {
    route,
    grant,
    via,
    background,
    consistent:
      running.length <= 1 &&
      (running.length === 0 || running[0] === grant?.owner) &&
      route?.slot === via?.slot,
  };
}
