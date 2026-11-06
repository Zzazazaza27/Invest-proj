#!/bin/bash
# Настройки входа без значений: хеши и токены заменены.
set -uo pipefail
sed -E 's/\$2[aby]\$[^ ]+/<хеш>/; s/(token|password|secret) .*/\1 <значение>/I' /etc/caddy/Caddyfile
