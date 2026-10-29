#!/usr/bin/env bash
# Создание служебных БД кластера при первой инициализации.
#   fifth_element      — основная OLTP-база (создаётся entrypoint'ом из POSTGRES_DB)
#   keycloak           — БД проверенного IdP; сессии/токены/ключи подписи живут
#                        ТАМ, а не в fifth_element (Database_Launch.md §2)
#   fifth_element_test — изолированная база для интеграционных тестов
set -Eeuo pipefail

# Своя роль для IdP: раньше Keycloak ходил в кластер под `unicorn_owner` —
# владельцем ВСЕХ схем платформы, включая регулируемые данные. Компрометация
# IdP означала бы доступ ко всему кластеру (MEDIUM внешнего аудита №2).
# Пароль берётся из окружения; отдельного секрета не заводим только там, где
# значение действительно одно и то же (см. compose).
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE ROLE keycloak LOGIN PASSWORD ' || quote_literal('${KEYCLOAK_DB_PASSWORD:-local_dev_only_kc_db_change_me}')
     WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'keycloak')\gexec
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-'EOSQL'
    SELECT 'CREATE DATABASE keycloak OWNER keycloak'
     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'keycloak')\gexec
    SELECT 'CREATE DATABASE fifth_element_test'
     WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'fifth_element_test')\gexec
EOSQL

echo "[init] databases ready: fifth_element, keycloak, fifth_element_test"
