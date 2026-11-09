# Образ статики 5Э: собранные приложения и nginx. Один на все среды: адрес ядра
# приходит при установке (`CORE_HOST`), API идёт на тот же origin.
# Сборка из корня репозитория:
#   docker build -f infra/images/web.Dockerfile -t fifth/web:<версия> .
FROM node:22.23.2-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig*.json ./
COPY packages ./packages
COPY apps ./apps
COPY database ./database
COPY scripts/vite-build.mjs ./scripts/vite-build.mjs
COPY scripts/lib/app-version.mjs scripts/lib/app-version.d.mts ./scripts/lib/
# Версия сборки в сообщениях об ошибках; git в образе нет.
ARG GIT_COMMIT=unknown
ENV GIT_COMMIT=$GIT_COMMIT
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npm run build:packages \
 && for app in web-public admin lab investor auth console; do npm run build -w "apps/$app" || exit 1; done

FROM nginx:1.27-alpine
COPY infra/nginx/default.conf /etc/nginx/templates/default.conf.template
COPY --chmod=755 infra/images/web-banner.sh /docker-entrypoint.d/40-env-banner.sh
# Файл маршрута по умолчанию, если установщик не подключил свой (блок 09, задание 3).
COPY --chmod=755 infra/images/web-route.sh /docker-entrypoint.d/15-fifth-route.sh
COPY --from=build /src/apps/web-public/dist /srv/web-public
COPY --from=build /src/apps/lab/dist /srv/lab
COPY --from=build /src/apps/investor/dist /srv/investor
COPY --from=build /src/apps/admin/dist /srv/admin
# Каталог по адресу: /login/ — root $static_root (блок 09, задание 3).
COPY --from=build /src/apps/auth/dist /srv/login
COPY --from=build /src/apps/console/dist /srv/console
HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD wget -q -O- http://127.0.0.1/ >/dev/null || exit 1
