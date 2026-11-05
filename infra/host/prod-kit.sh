#!/bin/bash
# Переходный комплект рабочей среды: .env и каталог секретов на ключ Томаса. Значения не печатаются.
set -Eeuo pipefail
export PATH=/usr/local/sbin:$PATH
fifth-transition-kit create
cut -c1-200 /var/backups/fifth-element/openbao-keys/transition.json
