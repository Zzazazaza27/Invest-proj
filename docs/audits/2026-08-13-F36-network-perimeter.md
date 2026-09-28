# SESSION AUDIT REPORT — Ф36: сетевой контур

Дата: 2026-08-13. Закрывает CODE-MED-07/SEC-HIGH-07, SEC-MED-01, кодовую часть
SEC-CRIT-03, CODE-MED-05/SEC-MED-04, SEC-MED-02 внешнего аудита 2026-08-13.

## Scope

- `apps/core/src/events/webhooks.service.ts` — `lookupWithDeadline`: DNS-резолв
  под пределом 5 с (Promise.race, таймер снимается в finally).
- `apps/core/src/events/ip-classifier.ts` — +5 диапазонов IPv6 из текущего
  реестра IANA; новый `addressInCidrs` (канонические 16 байт, v4-mapped).
- `apps/core/src/integration/service-auth.ts` — mTLS-заголовок принимается
  только от `socket.remoteAddress` ∈ `TRUSTED_PROXY_CIDRS`, иначе fail closed.
- `apps/core/src/content/content.service.ts` — landing через `asPublicRole`.
- `infra/docker-compose.yml` — политика `unicorn-app-rw`: явный список действий
  вместо `s3:*` + Deny `DeleteObjectVersion`; идемпотентное обновление политик
  (detach→rm→create→attach) — `create || true` существующую политику НЕ
  обновлял; тот же паттерн для `unicorn-archive-append`.
- `scripts/probe-object-versioning.mjs` — негативный контроль «app-учётка не
  может удалить версию (403)»; уборка версий под root-кредами.
- `apps/core/tests/events.test.ts` — +8 кейсов классификатора, +5 тестов CIDR.
- `.env.example` — задокументирован `INTEGRATION_CLIENT_CERT_HEADER`.

## Статус гейтов (доказательства этой сессии)

| Гейт                                    | Результат                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Тесты core                              | 221/221 (+13)                                                                               |
| `smoke-content`                         | 18/18 (landing под app_public_read)                                                         |
| `smoke-events`                          | 30/30 (вебхуки с DNS deadline)                                                              |
| `smoke-integration`                     | 53/53                                                                                       |
| `probe-object-versioning`               | 9/9, включая «удаление версии app-учёткой — 403»                                            |
| Негативный контроль применения политики | до фикса идемпотентности зонд показал 204 — сужение не применялось; после — 403             |
| Эксперимент с временной учёткой         | без DeleteObject — 403; Allow DeleteObject без Deny — 204; c Deny DeleteObjectVersion — 403 |
| `gate:net:strict`                       | 13/13, не выполнено: 0                                                                      |
| TypeScript / ESLint / Prettier          | 0 / 0 / чисто                                                                               |

## Findings

| Severity                 | Где              | Что                                                                            | Статус                                                                                |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| HIGH                     | webhooks.service | DNS lookup без предела времени (SEC-HIGH-07)                                   | FIXED                                                                                 |
| CRITICAL (кодовая часть) | service-auth     | mTLS-заголовок без привязки к доверенному прокси (SEC-CRIT-03)                 | FIXED в коде; периметр/прокси — production-IaC (BLOCKED внешней зависимостью, в TODO) |
| MEDIUM                   | ip-classifier    | Дрейф от реестра IANA (SEC-MED-01)                                             | FIXED (снимок 2026-08-13)                                                             |
| MEDIUM                   | content.service  | Landing через широкую роль (SEC-MED-04)                                        | FIXED                                                                                 |
| MEDIUM                   | docker-compose   | `s3:*` у учётки приложения (SEC-MED-02)                                        | FIXED (+Deny версий)                                                                  |
| MEDIUM                   | docker-compose   | `policy create \|\| true` молча не обновлял политику — новая находка этой фазы | FIXED (detach→rm→create→attach, доказано зондом)                                      |

## Ограничения

- Автогенерация IPv6-политики из IANA CSV с drift-check не сделана — ручной
  снимок реестра датирован в комментарии; идея остаётся в TODO-плане P2.
- Настоящий прокси с mTLS в локальном контуре отсутствует: привязка к
  TRUSTED_PROXY_CIDRS проверена юнит-тестами addressInCidrs и null-путём в
  dev; e2e с прокси — вместе с production-IaC.
- Негативный тест DNS-таймаута с реально зависшим резолвером не ставился
  (нужен управляемый DNS); предел покрыт кодом с очисткой таймера и живыми
  прогонами happy-path.
