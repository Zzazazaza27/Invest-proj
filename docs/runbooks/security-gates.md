# Runbook: гейты безопасности по завершении фазы

Прогоняется **после каждой фазы**, до коммита (`RULES.md` §3). Находки
исправляются немедленно, в той же фазе. Перенос в следующую фазу запрещён.

Правило отчёта: ✅ ставится только при наличии вывода команды из текущей
сессии. `— не проверялось (причина)` честнее ложного зелёного.

---

## 1. Прикладная безопасность и качество (§3.1, §3.3)

```bash
npm run lint          # граница фронт↔бэк, no-console, eqeqeq, запрет any
npm run typecheck     # TypeScript strict
npm run test          # юнит + интеграционные + негативные RLS
npm run gate:deps     # npm audit --audit-level=high → ожидание: 0
npm run format:check
```

SAST (semgrep) локально — через Docker, чтобы не тащить Python-окружение:

```powershell
docker run --rm -v "${PWD}:/src" -w /src semgrep/semgrep:latest `
  semgrep scan --config .semgrep/guardian.yml `
               --config p/typescript --config p/owasp-top-ten `
               --severity ERROR --metrics off
```

Ожидание: `Findings: 0 (0 blocking)`.

> **Важно:** semgrep сканирует только файлы, **отслеживаемые git**. На свежем
> репозитории до первого коммита количество целей будет заниженным. Смотри
> строку `Targets scanned:` и сверяй с ожидаемым объёмом кода.

Секрет-скан:

```bash
npm run gate:secrets   # gitleaks --config .gitleaks.toml → ожидание: 0
```

Python-зависимости AI-контура:

```bash
pip-audit -r apps/ai-gateway/requirements.txt --strict
```

---

## 2. Сетевая безопасность (§3.2)

```bash
npm run gate:net                                # против localhost:4300
node scripts/network-audit.mjs --api https://api.stage.unicorn.vc
```

Скрипт проверяет **фактическое состояние**, а не конфиг:

| Проверка            | Что делает                                                                           |
| ------------------- | ------------------------------------------------------------------------------------ |
| `container-ports`   | Реальные привязки портов из `docker ps`. Всё вне loopback — HIGH                     |
| `compose-bindings`  | Публикации портов в манифесте без `127.0.0.1` — HIGH                                 |
| `compose-anon`      | Анонимный вход, `trust`-аутентификация PostgreSQL — CRITICAL                         |
| `tls`               | `rejectUnauthorized:false`, `verify=False`, `curl -k`, TLS < 1.2 — CRITICAL/HIGH     |
| `cors`              | `origin:'*'` и отражение произвольного Origin при credentials — HIGH                 |
| `infra-credentials` | Похожее на реальный секрет в манифестах — CRITICAL                                   |
| `headers`           | Живой ответ API: CSP, X-Content-Type-Options, Referrer-Policy, COOP, X-Frame-Options |
| `cors-live`         | Запрос с `Origin: https://evil.example` не должен получить разрешение                |
| `cookie`            | HttpOnly, Secure, SameSite на всех выставляемых cookie                               |
| `banner`            | Раскрытие стека в `Server` / `X-Powered-By`                                          |

Скрипт различает «наш core не запущен» и «на порту чужой сервис»: живая
проверка засчитывается только если `/v1/health` возвращает
`{"service":"fifth-core"}`. Чужой 404 зелёным статусом не становится.

### Ручные проверки, которые скрипт не покрывает

```powershell
# Кто фактически слушает порт (Windows)
Get-NetTCPConnection -State Listen |
  Where-Object LocalPort -in 4300,5433,6380,4222,9000,8081 |
  ForEach-Object { [PSCustomObject]@{
      Port = $_.LocalPort; Addr = $_.LocalAddress
      Proc = (Get-Process -Id $_.OwningProcess).ProcessName } }
```

```bash
# Фактические заголовки ответа
curl -sS -D - -o /dev/null http://localhost:4300/v1/health

# Rate limit: 15 запросов подряд в класс money должны упереться в 429
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code} " http://localhost:4300/v1/billing/subscriptions
done; echo
```

TLS staging/production (проверка версии и шифров):

```bash
docker run --rm drwetter/testssl.sh --quiet --color 0 https://api.5espace.test
```

---

## 3. Известные грабли окружения

### `docker exec psql` требует пароль

Образ инициализируется с `--auth-local=scram-sha-256`, поэтому доверительной
локальной аутентификации нет. Это правильно — иначе дыра переехала бы в
production вместе с образом.

```bash
docker exec -e PGPASSWORD=<пароль> unicorn-postgres \
  psql -U unicorn_owner -d fifth_element -c "SELECT 1"
```

### Порт занят чужим проектом

На машине разработчика могут работать другие сервисы. Core использует **4300**
именно потому, что 4000 был занят посторонним процессом, слушавшим на всех
интерфейсах. Перед запуском:

```powershell
Get-NetTCPConnection -LocalPort 4300 -State Listen -ErrorAction SilentlyContinue
```

Если занят — не «подвинуть чужой сервис», а поменять `CORE_PORT` и
`VITE_API_BASE_URL`.

---

## 4. Что делать с находкой

| Severity                 | Действие                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------- |
| CRITICAL / HIGH / MEDIUM | Фикс в этой же фазе, до коммита. Гейт перепрогоняется                                   |
| LOW                      | Фикс либо статус ACCEPTED с письменным обоснованием в отчёте фазы                       |
| Не чинится в принципе    | Статус BLOCKED, уведомление владельца первым сообщением, работа по фазе останавливается |

Результат каждого прогона записывается в
`docs/audits/<YYYY-MM-DD>-<тема>.md` вместе с фактическим выводом команд.
