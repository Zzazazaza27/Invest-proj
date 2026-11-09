#!/bin/bash
# Вход и фоновая работа среды после выпуска — только чтение (выпуск 2.1.5, требование Тэнка:
# контроль входа, чтения данных и фоновой работы). Значений не печатает.
#
#   fifth-test op prod-env-activity test-1 | test-2 | prod
#
# Вход: попытка входа несуществующей учёткой — 401 значит, что путь входа работает и читает
# учётные записи из базы (ворота открыты, иначе 503). Фон: состояние задач со служебного
# порта ядра — имя, последний результат, без отказов.
set -Eeuo pipefail
ID="$1"
case "$ID" in
  prod)
    # Активное ядро и его порты (блок 09, задание 3).
    . "$(dirname "$(readlink -f "$0")")/core-slot.sh"
    CORE="$(active_core)" || exit 2; BASE="http://127.0.0.1:$(active_core_port)"; INTERNAL="$(active_core_internal_port)" ;;
  test-1 | test-2)
    CORE="fifth-$ID-core"; INTERNAL=4400
    PORT="$(sed -n 's/^FIFTH_WEB_PORT=//p' "/opt/fifth-element/.local/envs/$ID/compose.env")"
    BASE="http://127.0.0.1:$PORT"
    ;;
  *) echo 'среда: test-1, test-2 или prod' >&2; exit 2 ;;
esac
FAIL=0
email="nobody-$(date +%s)@activity.invalid"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST -H 'Content-Type: application/json' \
  --data "{\"email\":\"$email\",\"password\":\"activity-probe-$RANDOM\"}" "$BASE/v1/auth/login")"
if [ "$code" = 401 ]; then echo "  OK    вход несуществующей учёткой — 401 (путь входа и чтение учёток)"
else echo "  FAIL  вход — $code"; FAIL=1; fi
docker exec "$CORE" node -e "
fetch('http://127.0.0.1:$INTERNAL/jobs').then((r) => r.json()).then((b) => {
  const bad = b.jobs.filter((j) => j.enabled && j.lastStatus === 'failed');
  console.log('  ·     фон: ' + b.jobs.map((j) => j.name + '=' + (j.enabled ? j.lastStatus : 'выкл')).join(' '));
  console.log(bad.length ? '  FAIL  фоновые задачи с отказом: ' + bad.map((j) => j.name).join(', ') : '  OK    фоновые задачи без отказов');
  process.exit(bad.length ? 1 : 0);
}, () => { console.log('  FAIL  служебный порт ядра не ответил'); process.exit(1); });
" || FAIL=1
[ "$FAIL" = 0 ] && echo '▸ вход и фон в порядке' || echo '▸ вход или фон НЕ в порядке'
exit "$FAIL"
