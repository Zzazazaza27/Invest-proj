# PostgreSQL 16 для UNICORN LAUNCH.
#
# Требования Database_Launch.md §1: pgcrypto, pgvector (HNSW, vector(1536)),
# pg_partman 5.x, генерация UUIDv7.
#
# pgvector — из базового образа. pg_partman — из PGDG-репозитория Debian.
# UUIDv7 генерируется приложением (uuid v7 в TypeScript) и продублирован
# SQL-функцией public.uuid_generate_v7() на pgcrypto — расширение pg_uuidv7
# не собирается из исходников, чтобы не тащить в образ toolchain (см. ADR-004).
# Образ закреплён ДАЙДЖЕСТОМ, а не подвижным тегом: тег pg16 переезжает,
# и «тот же Dockerfile» собирал бы разные образы (принцип SEC-18, которым уже
# закреплены образы CI). Дайджест — тот же, что используется в CI-джобе БД.
FROM pgvector/pgvector@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b

USER root

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-16-partman; \
    rm -rf /var/lib/apt/lists/*

# Служебная БД для Keycloak создаётся один раз при инициализации кластера.
COPY init/00-databases.sh /docker-entrypoint-initdb.d/00-databases.sh
RUN chmod +x /docker-entrypoint-initdb.d/00-databases.sh

USER postgres
