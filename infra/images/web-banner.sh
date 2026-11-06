#!/bin/sh
# Плашка среды (блок 12). Образ один на все среды, поэтому надпись приходит при установке:
# FIFTH_ENV_LABEL пуст — плашки нет, как в рабочей среде. Строка добавляется в отдаваемый
# HTML, страницы приложений не меняются. Свёрнута в углу и не закрывает интерфейс; без скриптов,
# поэтому от политики содержимого не зависит.
[ -n "${FIFTH_ENV_LABEL:-}" ] || exit 0
cat > /etc/nginx/conf.d/00-env-banner.conf <<EOF
sub_filter '</body>' '<details data-env-banner style="position:fixed;right:8px;bottom:8px;z-index:2147483647;padding:2px 8px;border-radius:6px;background:#b45309;color:#fff;font:600 12px/1.4 system-ui,sans-serif;opacity:.85"><summary style="cursor:pointer">Тест</summary>${FIFTH_ENV_LABEL}</details></body>';
sub_filter_once on;
EOF
