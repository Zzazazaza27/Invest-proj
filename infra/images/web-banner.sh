#!/bin/sh
# Плашка среды (блок 12). Образ один на все среды, поэтому надпись приходит при установке:
# FIFTH_ENV_LABEL пуст — плашки нет, как в рабочей среде. Строка добавляется в отдаваемый
# HTML, страницы приложений не меняются.
[ -n "${FIFTH_ENV_LABEL:-}" ] || exit 0
cat > /etc/nginx/conf.d/00-env-banner.conf <<EOF
sub_filter '</body>' '<div data-env-banner style="position:fixed;top:0;left:0;right:0;z-index:2147483647;padding:4px 8px;background:#b45309;color:#fff;font:600 13px/1.4 system-ui,sans-serif;text-align:center;pointer-events:none">${FIFTH_ENV_LABEL}</div></body>';
sub_filter_once on;
EOF
