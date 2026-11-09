#!/bin/bash
# Время обычного запуска ядра по имеющимся данным, без перезапусков (зависание при запуске,
# 09.11.2026): журнал событий Docker хранит последние start и health_status контейнеров.
# От start до первого healthy — запуск ядра с точностью до интервала проверки (5 с) плюс
# время самой проверки. Только чтение.
#
#   fifth-test op prod-startup-times
set -Eeuo pipefail
# Активное ядро (блок 09, задание 3): в режиме слотов — по файлу маршрута.
. "$(dirname "$(readlink -f "$0")")/core-slot.sh"
CORE="$(active_core)" || exit 2
all="$(docker events --since 336h --until "$(date -u +%FT%TZ)" --format '{{.Type}}' 2>/dev/null | wc -l)"
echo "событий Docker в журнале за 14 суток: $all"
for c in "$CORE" fifth-test-1-core fifth-test-2-core; do
  docker events --since 336h --until "$(date -u +%FT%TZ)" --filter "container=$c" \
    --filter event=start --filter event=health_status --format '{{.TimeNano}} {{.Action}}' 2>/dev/null |
    node -e '
let s = "";
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const out = [];
  let start = null;
  for (const line of s.split("\n").filter(Boolean)) {
    const [ns, ...rest] = line.split(" ");
    const action = rest.join(" ");
    const t = Number(BigInt(ns) / 1000000n);
    if (action === "start") start = t;
    else if (action.startsWith("health_status: healthy") && start !== null) {
      out.push((t - start) / 1000);
      start = null;
    }
  }
  out.sort((a, b) => a - b);
  const name = process.argv[1];
  console.log(out.length
    ? `${name}: запусков ${out.length}, до первого healthy: минимум ${out[0]} с, медиана ${out[Math.floor(out.length / 2)]} с, максимум ${out.at(-1)} с`
    : `${name}: данных нет`);
});' "$c"
done
