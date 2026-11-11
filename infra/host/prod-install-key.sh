#!/bin/bash
# Замена открытого ключа подписи установщика (/etc/fifth-install/kit-signing.pub) — только этот
# файл, без переустановки инструментов и политики. Прежний сохраняется рядом с отметкой времени.
# Закрытых ключей здесь нет.
#
#   fifth-test op prod-install-key <открытый ключ PEM в base64>
set -Eeuo pipefail
B64="${1:?нужен открытый ключ в base64}"
ETC=/etc/fifth-install
[ -d "$ETC" ] || { echo "нет $ETC" >&2; exit 2; }
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
printf %s "$B64" | base64 -d >"$TMP"
# Только открытый Ed25519 в PEM: закрытый ключ сюда попасть не должен.
grep -q '^-----BEGIN PUBLIC KEY-----$' "$TMP" || { echo 'это не открытый ключ PEM' >&2; exit 2; }
! grep -q 'PRIVATE' "$TMP" || { echo 'закрытый ключ — отказ' >&2; exit 2; }
openssl pkey -pubin -in "$TMP" -noout -text 2>/dev/null | grep -q 'ED25519' || {
  echo 'ключ не Ed25519' >&2
  exit 2
}
[ -f "$ETC/kit-signing.pub" ] && cp -p "$ETC/kit-signing.pub" "$ETC/kit-signing.pub.before-$(date -u +%Y%m%dT%H%M%SZ)"
install -o root -g root -m 644 "$TMP" "$ETC/kit-signing.pub"
echo "открытый ключ заменён: $(sha256sum "$ETC/kit-signing.pub" | cut -c1-16)"
