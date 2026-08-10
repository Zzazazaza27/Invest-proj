#!/usr/bin/env bash
# Создание служебных БД кластера при первой инициализации.
#   unicorn_launch — основная OLTP-база (создаётся entrypoint'ом из POSTGRES_DB)
#   keycloak       — БД проверенного IdP; сессии/токены/ключи подписи живут ТАМ,
#                    а не в unicorn_launch (Database_Launch.md §2)
#   unicorn_test   — изолированная база для интеграционных тестов
set -Eeuo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    SELECT 'CREATE DATABASE keycloak'
     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec
    SELECT 'CREATE DATABASE unicorn_test'
     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'unicorn_test')\gexec
EOSQL

echo "[init] databases ready: unicorn_launch, keycloak, unicorn_test"
