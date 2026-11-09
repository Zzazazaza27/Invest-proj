#!/bin/bash
# Вход на test-1 тем же паролем, что на prod (Томас 10.11: доступ к test-1 может быть тем же).
# Строка `thomas` блока basic_auth сайта 5espace.com копируется в блок test-1; пароль и хеш
# через этот шаг не передаются и не печатаются. Строка `tester` остаётся.
# Резервная копия, проверка конфигурации, перезагрузка без остановки, проверка ответов;
# при любом сбое — прежний файл и перезагрузка.
#   fifth-test op prod-test1-auth-as-prod
set -Eeuo pipefail
CADDY=/etc/caddy/Caddyfile
BACKUP="$CADDY.before-test1-auth-as-prod"
cp -p "$CADDY" "$BACKUP"
back() {
  echo "сбой на строке $1: возвращаю прежний Caddyfile"
  cp -p "$BACKUP" "$CADDY"
  systemctl reload caddy || true
  exit 1
}
trap 'back $LINENO' ERR
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$1"; }
prod_before=$(code https://5espace.com/)
t2_before=$(code https://test-2.5espace.com/v1/health)

node -e "
const fs=require('fs');const f='$CADDY';const t=fs.readFileSync(f,'utf8');
const prod=t.match(/^5espace\.com \{\n[\s\S]*?\n\}\n/m);
const line=prod && prod[0].match(/^\t\tthomas \S+\n/m);
if(!line){console.error('в блоке prod нет строки thomas');process.exit(1);}
const m=t.match(/^test-1\.5espace\.com \{\n[\s\S]*?\n\}\n/m);
if(!m){console.error('нет блока test-1');process.exit(1);}
if(/^\t\tthomas /m.test(m[0])){console.log('строка thomas в test-1 уже есть');process.exit(0);}
const auth=m[0].match(/\tbasic_auth \{\n/);
if(!auth){console.error('в блоке test-1 нет basic_auth');process.exit(1);}
const next=m[0].replace(/\tbasic_auth \{\n/,(a)=>a+line[0]);
fs.writeFileSync(f,t.replace(m[0],()=>next));
console.log('строка thomas добавлена в test-1');"
caddy validate --config "$CADDY" --adapter caddyfile >/dev/null 2>&1
systemctl reload caddy
sleep 2
t1=$(code https://test-1.5espace.com/)
prod=$(code https://5espace.com/)
t2=$(code https://test-2.5espace.com/v1/health)
echo "test-1 без пароля: $t1; prod: $prod (было $prod_before); test-2 /v1/health: $t2 (было $t2_before)"
[ "$t1" = 401 ] && [ "$prod" = "$prod_before" ] && [ "$t2" = "$t2_before" ]
trap - ERR
echo 'готово: test-1 принимает вход prod (thomas); копия прежнего файла — '"$BACKUP"
