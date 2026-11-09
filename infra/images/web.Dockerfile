# Образ статики 5Э: собранные приложения и nginx. Один на все среды: адрес ядра
# приходит при установке (`CORE_HOST`), API идёт на тот же origin.
# Сборка из корня репозитория:
#   docker build -f infra/images/web.Dockerfile -t fifth/web:<версия> .
FROM node:22.23.2-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS build
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

FROM nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
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
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=2s --retries=3 \
  CMD wget -q -O- http://127.0.0.1/ >/dev/null || exit 1
