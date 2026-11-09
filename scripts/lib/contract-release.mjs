/**
 * Выпуск с contract-миграцией (блок 09, задание 4; уточнение Тэнка 09.11, п. 5).
 *
 * Несовместимое изменение схемы НЕ проводится поверх обслуживающего старого ядра как
 * бесшовный выпуск: прежний код на новой схеме не работает. Порядок — с остановкой:
 *
 *  1. разрешение фона снимается, фон старого — на паузу до окончания проходов;
 *  2. старое ядро останавливается, остановка подтверждается — с этого момента перерыв
 *     (страница недоступности Caddy);
 *  3. миграции — включая contract;
 *  4. кандидат в другом слоте; готовность и проверки в его порт;
 *  5. маршрут → nginx -t → мягкая перезагрузка → подтверждение запросом;
 *  6. разрешение и фон — кандидату.
 *
 * Возврата на прежний код нет (точка возврата запрещена правилом задания 2). Отказ после
 * миграции — остановка с тревогой; исправление — следующей сборкой вперёд. Отказ до
 * миграции (пауза, остановка старого) — старое ядро возвращается в работу.
 *
 * Действия — тот же порт `ops`, что у switchSlots, плюс `ops.migrate()`, `ops.startSlot(slot)`.
 */
export async function contractRelease(ops, plan) {
  const o = {
    readyWaitMs: 120_000,
    stopWaitMs: 60_000,
    confirmSamples: 5,
    confirmWaitMs: 15_000,
    pollMs: 2_000,
    confirmIntervalMs: 200,
    ...plan.limits,
  };
  const { from, to, build, prevBuild } = plan;
  const say = (stage, status, detail = '') => ops.record(stage, status, detail);
  const until = async (check, ms) => {
    const end = ops.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (ops.now() >= end) return false;
      await ops.sleep(o.pollMs);
    }
  };
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
  // До миграции старый ещё годится: вернуть его в работу.
  const restoreOld = async (stage, why) => {
    say(stage, 'fail', why);
    await ops.startSlot(from);
    const ready = await until(() => ops.ready(from), o.readyWaitMs);
    ops.writeGrant(from);
    const mode = ready ? await ops.resume(from) : 'не готов';
    say('restore-old', ready && mode === 'running' ? 'ok' : 'fail', mode);
    return { ok: false, stage, detail: why, active: from, migrated: false };
  };
  // После миграции старого не вернуть: только исправление вперёд.
  const forwardOnly = (stage, why) => {
    say(
      stage,
      'fail',
      `${why}; contract-миграция применена — возврата нет, исправление следующей сборкой`,
    );
    return { ok: false, stage, detail: why, active: 'none', migrated: true, forwardOnly: true };
  };

  say('contract', 'start', `${from} → ${to}, сборка ${build}; выпуск с остановкой`);
  ops.writeGrant(null);
  const paused = await ops.pause(from);
  if (paused !== 'paused') return restoreOld('pause', `фон старого не на паузе: ${paused}`);
  say('pause', 'ok');

  await ops.stopSlot(from);
  const stopped = await until(async () => (await ops.slotStopped(from)) === true, o.stopWaitMs);
  if (!stopped) return restoreOld('stop-old', 'остановка старого не подтверждена');
  say('stop-old', 'ok', 'перерыв начат');

  const migrated = await ops.migrate();
  if (!migrated.ok) {
    // Транзакционная миграция откатилась целиком (задание 2) — старый код ещё годится.
    if (migrated.applied === false) return restoreOld('migrate', migrated.detail);
    return forwardOnly('migrate', migrated.detail);
  }
  say('migrate', 'ok', migrated.detail ?? '');

  await ops.startCandidate(to, build);
  if (!(await until(() => ops.ready(to), o.readyWaitMs)))
    return forwardOnly('candidate', 'кандидат не готов');
  const checks = await ops.candidateChecks(to);
  if (!checks.ok) return forwardOnly('candidate', `проверки кандидата: ${checks.detail}`);
  say('candidate', 'ok');

  ops.writeRoute({ slot: to, build, prevBuild });
  const reload = await ops.reloadNginx();
  if (!reload.ok) return forwardOnly('reload', `перезагрузка nginx: ${reload.detail}`);
  if (!(await confirmed(to, build)))
    return forwardOnly('confirm', 'через nginx отвечает не кандидат');
  say('confirm', 'ok', 'перерыв окончен');

  ops.writeGrant(to);
  const mode = await ops.resume(to);
  if (mode !== 'running') return forwardOnly('grant', `фон кандидата не запустился: ${mode}`);
  say('grant', 'ok', `owner=${to}`);
  return { ok: true, stage: 'done', detail: '', active: to, migrated: true };
}
