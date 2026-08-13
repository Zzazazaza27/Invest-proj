# SESSION AUDIT REPORT — Ф41: least privilege по БД и инварианты (M056)

Дата: 2026-08-13. Закрывает семь находок MEDIUM/LOW аудита №2 по базе данных.

## Scope

`database/migrations/M056_least_privilege_and_invariants.sql`:

1. Поколоночный `GRANT SELECT (id, display_name, primary_role, status, locale)`
   на `identity.users` для `app_investments`/`app_billing`/`app_notifications`
   вместо полного (был доступ к `password_hash`, шифртекстам, DEK, hmac).
2. Поколоночный `GRANT UPDATE` для `app_backend` (профиль + `status`,
   `updated_at`, `sessions_valid_from`); `primary_role`, `deleted_at`,
   контакты и blind-индексы больше не изменяемы пользовательским контекстом.
3. SELECT-политики материалов требуют `uploaded_at IS NOT NULL`.
4. `has_required_consents` требует существования всех четырёх обязательных
   видов в локали.
5. `has_valid_kyc` блокирует `sanctions_status = 'review'`.
6. Триггер `offer_target_guard` на снижение `target_amount` ниже набранного.
7. `integration.find_token_candidate(client_id)` (SECURITY DEFINER) вместо
   прямого чтения всех `client_secret_hash`; поколоночный GRANT на таблицу.

Плюс `apps/core/src/integration/integration.service.ts` (выдача токена через
функцию) и `database/tests/rls.test.ts` (+6 тестов).

## Статус гейтов (доказательства этой сессии)

| Гейт | Результат |
|---|---|
| `lint:migrations` | 0 ошибок, 1 прежний WARN |
| Миграция M056 | применена к основной и тестовой БД |
| Тесты БД | 61/61 (+6) |
| `smoke-integration` | 53/53 (выдача токена через definer-функцию) |
| `smoke-lab` | 93/93 (материалы под новой политикой) |
| `smoke-investments` | 34/34 |
| `smoke-experts` | 49/49 (материалы рецензенту, has_valid_kyc) |
| `smoke-core` | 46/46 (регистрация, активация по согласиям) |
| `check-definer-privileges` | 0 нарушений |
| `check-service-roles` | 42/42 |
| `gate:net` | пройден |
| TypeScript / ESLint / Prettier | 0 / 0 / чисто |

## Findings

| Severity | Что | Статус |
|---|---|---|
| MEDIUM | `password_hash` и контакты доступны трём сервисным ролям | FIXED (доказано тестом: SELECT колонки → отказ, разрешённые колонки читаются) |
| MEDIUM | `users_update_self` позволял менять системные колонки | FIXED (тест: primary_role/email_hmac/deleted_at — отказ, display_name — проходит) |
| LOW | Неподтверждённые материалы видны в SELECT | FIXED (тест: pending отсутствует в выборке, confirmed присутствует) |
| LOW | `has_required_consents` на пустой локали | FIXED (тест) |
| LOW | `has_valid_kyc` пропускал `review` | FIXED (тест) |
| LOW | Ёмкость оффера не защищена при UPDATE | FIXED (триггер) |
| LOW | `app_integration` читала все `client_secret_hash` | FIXED (definer-функция; smoke-integration 53/53) |

## Ограничения

- Argon2id-сравнение остаётся в приложении (соль внутри хеша) — функция сужает
  объём доступного материала до одного `client_id`, но не убирает хеш из
  выдачи вовсе; это предел без смены схемы хранения секретов.
- Триггер ёмкости оффера покрыт кодом, но живого прогона на снижение
  `target_amount` нет: регулируемый контур выключен фичефлагом.

## Грабля сессии

`dev-core.mjs` не перезапускает ядро при занятом порте — старый процесс
продолжал работать со старым `dist`, и smoke-integration дал 34 FAIL
«permission denied». После явного `taskkill` + рестарта — 53/53. Вывод:
перезапуск подтверждается сменой pid, а не отсутствием ошибки в выводе.
