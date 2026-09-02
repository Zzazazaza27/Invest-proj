# SESSION AUDIT REPORT — Ф45: инфраструктура и скрипты

Дата: 2026-08-13. Закрывает HIGH (отсутствующий realm-файл), MEDIUM
(Keycloak под владельцем схем) и четыре LOW аудита №2.

## Scope

- `infra/keycloak/realm-launch.json` + `README.md` — новый realm локального
  контура (без секретов и пользователей).
- `infra/docker-compose.yml` — монтируется каталог импорта; сервис
  `keycloak-db-init`; Keycloak подключается ролью `keycloak`; проброс
  `KEYCLOAK_DB_PASSWORD` в postgres.
- `infra/postgres/init/00-databases.sh` — роль-владелец БД Keycloak.
- `infra/postgres/Dockerfile` — базовый образ по дайджесту.
- `scripts/rotate-kek.mjs` — атомарная запись `.env` (tmp + rename).
- `scripts/rotate-stand-secrets.mjs` — автоудаление бэкапа секретов.
- `scripts/gate-ai-gateway.mjs` — `pip-audit --strict` как в CI.
- `.env.example`, `.env` — `KEYCLOAK_DB_PASSWORD`.

## Статус гейтов (доказательства этой сессии)

| Гейт                                      | Результат                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `docker compose config`                   | валиден                                                                                        |
| Сборка `unicorn/postgres:16` по дайджесту | успешна                                                                                        |
| `keycloak-db-init`                        | exit 0, «роль и БД keycloak готовы»                                                            |
| Keycloak под ролью `keycloak`             | поднялся; до фикса — `password authentication failed` (негативный контроль получен фактически) |
| Импорт realm                              | «Realm 'unicorn-launch' imported»; до фикса — `Unrecognized field "_comment"`                  |
| OIDC discovery                            | 200, issuer корректен, `authorization_endpoint` есть                                           |
| JWKS                                      | 200, 2 ключа; PKCE `S256` поддерживается                                                       |
| `gate:net`                                | пройден                                                                                        |
| `gate:secret-reuse`                       | OK                                                                                             |
| `gate:sast-config`                        | 0                                                                                              |
| `gate:ai` (теперь с `--strict`)           | пройден                                                                                        |
| ESLint / синтаксис скриптов               | 0                                                                                              |

## Findings

| Severity | Что                                                            | Статус                                          |
| -------- | -------------------------------------------------------------- | ----------------------------------------------- |
| HIGH     | `realm-launch.json` отсутствовал — профиль `idp` не поднимался | FIXED (realm импортирован вживую)               |
| MEDIUM   | Keycloak = `unicorn_owner` (владелец всех схем платформы)      | FIXED (своя роль + идемпотентная инициализация) |
| LOW      | Неатомарная запись `.env` в `rotate-kek`                       | FIXED                                           |
| LOW      | `pip-audit` без `--strict` локально                            | FIXED                                           |
| LOW      | Базовый образ по подвижному тегу                               | FIXED (дайджест)                                |
| LOW      | Бэкап старых секретов оставался на диске                       | FIXED (автоудаление)                            |

## Ограничения

- Полный OIDC-вход через Keycloak (обмен кода на сессию) по-прежнему не
  реализован в ядре — это CRITICAL аудита №1, требующий кода BFF; здесь
  подготовлена только инфраструктура (realm, клиент, PKCE). Остаётся в TODO.
- Секрет клиента `unicorn-launch-core` в realm не хранится: его задаёт
  оператор при первом запуске. Значит `AUTH_MODE=oidc` end-to-end в этой фазе
  не проверялся — проверены только discovery и JWKS.
