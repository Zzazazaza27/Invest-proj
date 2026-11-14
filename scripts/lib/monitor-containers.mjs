/**
 * Запись о контейнере для выгрузки наблюдения (monitor-export.mjs). Чистая функция над
 * результатом `docker inspect`: проверяется модульно.
 *
 * `recoveryStopped` — последняя строка проверки здоровья содержит `recovery=stopped`
 * (core-health.mjs): предел автоматических перезапусков зависшего ядра исчерпан.
 * `crashLoop` — в той же строке `mode=slow`: ядро в петле падений, запуски не чаще раза в
 * 10 минут (core-start.mjs). Текст проверки наружу не выгружается — только признаки.
 *
 * `standby` — резервный слот ядра: после переключения прежний слот останавливается намеренно
 * (slot-switch.mjs, «stop-old»), и тревога «Контейнеры: не работают» на него — ложная
 * (найдено 14.11.2026: test-1 после перехода на core-b). Остановка активного слота — тревога.
 */
export function containerRecord(c, standby = new Set()) {
  const log = c.State?.Health?.Log ?? [];
  const last = log.length ? String(log[log.length - 1].Output ?? '') : '';
  const name = String(c.Name ?? '').replace(/^\//, '');
  const isStandby = standby.has(name);
  return {
    name,
    state: c.State?.Status ?? null,
    health: c.State?.Health?.Status ?? null,
    restarts: c.RestartCount ?? 0,
    expected: !isStandby && (c.HostConfig?.RestartPolicy?.Name ?? 'no') !== 'no',
    ...(isStandby ? { standby: true } : {}),
    recoveryStopped: /\brecovery=stopped\b/.test(last),
    crashLoop: /\bmode=slow\b/.test(last),
  };
}

/**
 * Имена контейнеров резервных слотов. `routes` — [{ prefix, route }]: prefix — `fifth` для
 * рабочей среды или `fifth-test-1` для среды, route — разобранный core-route.json или null.
 * Слот core-a — контейнер `<prefix>-core`, core-b — `<prefix>-core-b`. Маршрута нет или он
 * не разбирается — режима слотов нет, резерва нет.
 */
export function standbyContainers(routes) {
  const out = new Set();
  for (const { prefix, route } of routes) {
    if (route?.slot === 'core-a') out.add(`${prefix}-core-b`);
    else if (route?.slot === 'core-b') out.add(`${prefix}-core`);
  }
  return out;
}
