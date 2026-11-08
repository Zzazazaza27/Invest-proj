/**
 * Запись о контейнере для выгрузки наблюдения (monitor-export.mjs). Чистая функция над
 * результатом `docker inspect`: проверяется модульно.
 *
 * `recoveryStopped` — последняя строка проверки здоровья содержит `recovery=stopped`
 * (core-health.mjs): предел автоматических перезапусков зависшего ядра исчерпан.
 * `crashLoop` — в той же строке `mode=slow`: ядро в петле падений, запуски не чаще раза в
 * 10 минут (core-start.mjs). Текст проверки наружу не выгружается — только признаки.
 */
export function containerRecord(c) {
  const log = c.State?.Health?.Log ?? [];
  const last = log.length ? String(log[log.length - 1].Output ?? '') : '';
  return {
    name: String(c.Name ?? '').replace(/^\//, ''),
    state: c.State?.Status ?? null,
    health: c.State?.Health?.Status ?? null,
    restarts: c.RestartCount ?? 0,
    expected: (c.HostConfig?.RestartPolicy?.Name ?? 'no') !== 'no',
    recoveryStopped: /\brecovery=stopped\b/.test(last),
    crashLoop: /\bmode=slow\b/.test(last),
  };
}
