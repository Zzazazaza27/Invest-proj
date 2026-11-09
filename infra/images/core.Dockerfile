# Образ ядра 5Э. Один на все среды: идентификатор среды, настройки площадки и
# секреты приходят при установке (переменные и `<ИМЯ>_FILE`), в образ не зашиваются.
# Сборка из корня репозитория:
#   docker build -f infra/images/core.Dockerfile -t fifth/core:<версия> .
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY database ./database
# Корневой `prepare` настраивает git-хуки, git в образе нет: скрипты отключены,
# нативные модули собираются отдельно.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm rebuild argon2 sharp \
 && npm run build -w packages/contracts \
 && npm run build -w apps/core \
 && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
ARG GIT_COMMIT=unknown
ENV NODE_ENV=production \
    RELEASE_SHA=$GIT_COMMIT \
    CORE_INTERNAL_PORT=4400
WORKDIR /app
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/package.json ./package.json
COPY --from=build --chown=node:node /src/packages/contracts ./packages/contracts
COPY --from=build --chown=node:node /src/apps/core/package.json ./apps/core/package.json
COPY --from=build --chown=node:node /src/apps/core/dist ./apps/core/dist
COPY --from=build --chown=node:node /src/database ./database
COPY --chown=node:node infra/images/core-health.mjs infra/images/core-health-policy.mjs \
  infra/images/core-start.mjs infra/images/core-start-policy.mjs ./
COPY --chown=node:node scripts/nats-init-stream.mjs ./scripts/nats-init-stream.mjs
COPY --chown=node:node scripts/lib/secret-files.mjs ./scripts/lib/secret-files.mjs
USER node
EXPOSE 4300
# Живость — служебный /live; публичный /v1/health её не заменяет.
HEALTHCHECK --interval=5s --timeout=4s --start-period=30s --retries=3 \
  CMD ["node", "core-health.mjs"]
# Ядро — дочерний процесс обёртки: учёт падений и редкий режим (core-start.mjs).
CMD ["node", "core-start.mjs"]
