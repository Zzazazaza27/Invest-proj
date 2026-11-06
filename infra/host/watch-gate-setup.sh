#!/bin/bash
# С ноутбука, один раз: новый пароль учётки `watch` на входе рабочей среды и в секрете 5e_watch.
# Значение живёт только в этой команде, на экран и в файлы не попадает.
set -euo pipefail
cd "$(dirname "$0")/../.."
S=(ssh -i "$HOME/.ssh/maus_5e" -o IdentitiesOnly=yes -o BatchMode=yes maus@193.233.217.210)
secret="$(openssl rand -hex 24)"
printf '%s\n' "$secret" | "${S[@]}" 'sudo -n /usr/local/sbin/fifth-test op prod-gate-watch'
printf 'watch:%s' "$secret" | gh secret set FIVE_E_GATE_AUTH -R rebel-diesel/scripts
unset secret
gh workflow run 5e-watch.yml -R rebel-diesel/scripts
echo 'готово: внешняя проверка запущена, тревога снимется сама'
