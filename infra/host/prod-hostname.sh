#!/bin/bash
# Имя узла (Томас 18.11): unicorn.ptr.network досталось от Unicorn и провайдера и снаружи не
# разрешается. Переименование в панели хостера до системы не доходит (cloud-init нет), поэтому
# имя меняется на узле. Новое имя — то же, что обратная запись IP (PTR mail.5espace.com): им же
# представляется почта, расхождения hostname / PTR / HELO не остаётся.
#
#   fifth-test op prod-hostname plan            где сейчас старое имя; только чтение
#   fifth-test op prod-hostname apply <имя>     hostname, /etc/hosts, /etc/mailname, exim
#   fifth-test op prod-hostname rollback        вернуть файлы из копии и прежнее имя
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
H=/usr/local/hestia
BK=/var/backups/fifth-element/hostname
FILES=(/etc/hostname /etc/hosts /etc/mailname /etc/exim4/update-exim4.conf.conf)
show() {
  echo "hostname: $(hostname)"
  echo "PTR 193.233.217.210: $(dig +short -x 193.233.217.210 | head -1)"
  echo "exim primary_hostname: $(exim -bP primary_hostname 2>/dev/null | cut -d= -f2 | xargs)"
  echo "mailname: $(cat /etc/mailname 2>/dev/null)"
  echo '/etc/hosts (127.*):'; grep -E '^127\.' /etc/hosts | sed 's/^/  /'
  echo "старое имя в /etc: $(grep -rlF "$(hostname)" /etc 2>/dev/null | grep -v '^/etc/ssh/ssh_host_' | tr '\n' ' ')"
}
case "${1:-plan}" in
  plan) show ;;
  apply)
    NEW="${2:-}"
    [[ "$NEW" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || { echo 'нужно имя вида mail.5espace.com' >&2; exit 2; }
    OLD="$(hostname)"
    [ "$OLD" = "$NEW" ] && { echo "имя уже $NEW"; exit 0; }
    install -d -m 700 "$BK"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir "$BK/$stamp"
    for f in "${FILES[@]}"; do [ -f "$f" ] && cp -p "$f" "$BK/$stamp/"; done
    echo "$OLD" > "$BK/$stamp/old-hostname"
    # Hestia: hostname, /etc/hostname, строка 127.0.0.1 и журнал действий панели.
    "$H/bin/v-change-sys-hostname" "$NEW"
    # Строки 127.0.1.1 со старым именем (их ставил установщик ОС) — на новое; повторы убрать.
    sed -i -E "s/^127\.0\.1\.1\s+${OLD//./\\.}$/127.0.1.1 ${NEW}/" /etc/hosts
    awk '!(/^127\.0\.1\.1 / && seen[$0]++)' /etc/hosts > "$BK/$stamp/hosts.new" && cat "$BK/$stamp/hosts.new" > /etc/hosts
    echo "$NEW" > /etc/mailname
    [ -f /etc/exim4/update-exim4.conf.conf ] && sed -i "s/${OLD//./\\.}/${NEW}/g" /etc/exim4/update-exim4.conf.conf
    systemctl restart exim4
    echo "копия файлов: $BK/$stamp"
    show
    echo "exim: $(systemctl is-active exim4), dovecot: $(systemctl is-active dovecot)"
    ;;
  rollback)
    last="$(ls -1d "$BK"/*/ 2>/dev/null | tail -1)"
    [ -n "$last" ] || { echo 'копии нет' >&2; exit 1; }
    OLD="$(cat "$last/old-hostname")"
    for f in "${FILES[@]}"; do [ -f "$last/$(basename "$f")" ] && cp -p "$last/$(basename "$f")" "$f"; done
    hostnamectl set-hostname "$OLD"
    systemctl restart exim4
    show
    ;;
  *) echo 'команды: plan, apply <имя>, rollback' >&2; exit 2 ;;
esac
