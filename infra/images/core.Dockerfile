# Образ ядра 5Э. Один на все среды: идентификатор среды, настройки площадки и
# секреты приходят при установке (переменные и `<ИМЯ>_FILE`), в образ не зашиваются.
# Сборка из корня репозитория:
#   docker build -f infra/images/core.Dockerfile -t fifth/core:<версия> .
FROM node:22.23.2-bookworm-slim AS build
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

FROM node:22.23.2-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/package.json ./package.json
COPY --from=build --chown=node:node /src/packages/contracts ./packages/contracts
COPY --from=build --chown=node:node /src/apps/core/package.json ./apps/core/package.json
COPY --from=build --chown=node:node /src/apps/core/dist ./apps/core/dist
COPY --from=build --chown=node:node /src/database ./database
USER node
EXPOSE 4300
# Первая проверка живости: основная — служебные /live и /ready в Compose.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CORE_PORT||4300)+'/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/core/dist/main.js"]
