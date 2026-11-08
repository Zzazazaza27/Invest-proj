#!/bin/bash
# Страница и problem+json недоступности на входе (блок 2, 2.3; выпуск W13–W21, отдельный шаг).
# apply  — фрагмент infra/caddy/unavailable.caddy в общий Caddyfile: импорт и `import
#          fifth_unavailable` в блоках платформы (5espace.com, test-1, test-2);
# revert — прежний Caddyfile из копии этого шага.
# До изменения: проверка фрагмента временным Caddy на петле с мёртвым бэкендом (рабочий трафик
# не затрагивается). После: validate, reload, коды маршрутов сред — те же, что до изменения;
# иначе прежний файл возвращается. Значений не печатает.
#
#   fifth-test op prod-caddy-unavailable apply|revert
set -Eeuo pipefail
MODE="${1:-}"
[[ "$MODE" =~ ^(apply|revert)$ ]] || { echo 'режим: apply или revert' >&2; exit 2; }
ROOT=/opt/fifth-element
CADDY=/etc/caddy/Caddyfile
BEFORE=/etc/caddy/Caddyfile.before-unavailable
FRAGMENT="$ROOT/infra/caddy/unavailable.caddy"
CREDENTIALS=/etc/fifth-gate/monitor.credentials
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

auth() { curl -s --max-time 20 -K <(printf 'user = "%s"\n' "$(cat "$CREDENTIALS")") "$@"; }
# Коды маршрутов сред: без учётки и с учёткой наблюдения (только рабочая среда).
routes() {
  for u in https://5espace.com/ https://5espace.com/v1/ready https://www.5espace.com/ \
    https://test-1.5espace.com/ https://test-2.5espace.com/ https://test-2.5espace.com/v1/ready; do
    printf '%s %s\n' "$u" "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$u")"
  done
  for p in / /v1/ready /lab/; do
    printf 'auth https://5espace.com%s %s\n' "$p" "$(auth -o /dev/null -w '%{http_code}' "https://5espace.com$p")"
  done
}
reload_and_check() {
  caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1 || return 1
  systemctl reload caddy || return 1
  sleep 2
  routes >"$WORK/after"
  diff -u "$WORK/before" "$WORK/after" >/dev/null
}

routes >"$WORK/before"
echo '▸ маршруты до изменения'
sed 's/^/  /' "$WORK/before"

if [ "$MODE" = revert ]; then
  [ -f "$BEFORE" ] || { echo "нет копии $BEFORE" >&2; exit 1; }
  cp -p "$CADDY" "$WORK/current"
  cp -p "$BEFORE" "$CADDY"
  if reload_and_check; then
    echo '▸ прежний Caddyfile возвращён, маршруты те же'
    exit 0
  fi
  cp -p "$WORK/current" "$CADDY"
  systemctl reload caddy || true
  echo 'возврат не прошёл проверку — оставлен файл до возврата' >&2
  exit 1
fi

if grep -q 'infra/caddy/unavailable.caddy' "$CADDY"; then
  echo 'фрагмент уже подключён'
  exit 0
fi

echo '▸ фрагмент на временном Caddy (петля, мёртвый бэкенд)'
cat >"$WORK/probe.caddy" <<EOF
{
	admin off
	auto_https off
}
import $FRAGMENT
http://127.0.0.1:18999 {
	import fifth_unavailable
	reverse_proxy 127.0.0.1:9
}
EOF
caddy run --config "$WORK/probe.caddy" --adapter caddyfile >"$WORK/probe.log" 2>&1 &
PROBE=$!
for _ in $(seq 1 20); do
  curl -s -o /dev/null --max-time 1 http://127.0.0.1:18999/ && break
  sleep 0.5
done
api_code="$(curl -s -o "$WORK/api" -w '%{http_code} %{content_type}' --max-time 5 http://127.0.0.1:18999/v1/projects)"
page_code="$(curl -s -o "$WORK/page" -w '%{http_code} %{content_type}' --max-time 5 http://127.0.0.1:18999/lab/)"
kill "$PROBE" 2>/dev/null || true
wait "$PROBE" 2>/dev/null || true
echo "  /v1/projects: $api_code; тело: $(grep -o '"code":"[a-z_]*"' "$WORK/api" | head -1)"
echo "  /lab/: $page_code; страница: $(grep -c 'data-unavailable-page' "$WORK/page")"
[[ "$api_code" == '502 application/problem+json'* ]] && grep -q '"status":502' "$WORK/api" &&
  [[ "$page_code" == '502 text/html'* ]] && grep -q 'data-unavailable-page' "$WORK/page" || {
  echo 'фрагмент на временном Caddy ведёт себя не так — общий Caddyfile не изменён' >&2
  exit 1
}

echo '▸ подключение к общему Caddyfile'
cp -p "$CADDY" "$BEFORE"
node -e "
const fs=require('fs');const f='$CADDY';let t=fs.readFileSync(f,'utf8');
const imp='import /opt/fifth-element/infra/caddy/access-log.caddy\n';
if(!t.includes(imp))process.exit(3);
t=t.replace(imp,imp+'import /opt/fifth-element/infra/caddy/unavailable.caddy\n');
const sites=[/^(5espace\.com \{\n\timport fifth_access_log\n)/m,/^(test-2\.5espace\.com \{\n\timport fifth_access_log\n)/m,/^(test-1\.5espace\.com \{\n)/m];
for(const re of sites){if(!re.test(t))process.exit(4);t=t.replace(re,'\$1\timport fifth_unavailable\n');}
fs.writeFileSync(f,t);
" || {
  cp -p "$BEFORE" "$CADDY"
  echo 'структура Caddyfile не та, что ожидалась — не изменён' >&2
  exit 1
}
if reload_and_check; then
  echo '▸ подключено: 5espace.com, test-1, test-2; маршруты те же'
  sed 's/^/  /' "$WORK/after"
  echo "  возврат: fifth-test op prod-caddy-unavailable revert (копия $BEFORE)"
  exit 0
fi
echo 'проверка после подключения не прошла — возвращаю прежний Caddyfile' >&2
cp -p "$BEFORE" "$CADDY"
systemctl reload caddy || true
[ -f "$WORK/after" ] && diff -u "$WORK/before" "$WORK/after" | sed 's/^/  /' >&2 || true
exit 1
