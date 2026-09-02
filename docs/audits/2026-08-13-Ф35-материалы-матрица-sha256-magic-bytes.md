# SESSION AUDIT REPORT — Ф35: материалы — матрица типов, sha256, magic bytes

Дата: 2026-08-13. Закрывает SEC-HIGH-02 (кодовая часть CODE-HIGH-09),
SEC-HIGH-03, CODE-MED-02 внешнего аудита 2026-08-13.

## Scope

- `packages/contracts/src/domain/lab.ts` — `MATERIAL_UPLOAD_RULES`
  (тип → MIME → размер, один источник правды); `RequestUploadSchema.superRefine`
  отвергает MIME и размер, недопустимые для типа.
- `packages/contracts/tests/contracts.test.ts` — +6 тестов матрицы.
- `apps/core/src/storage/s3.service.ts` — `getObjectDigest()`: потоковое
  чтение объекта, sha256 инкрементально, первые 16 байт для сигнатуры,
  таймаут 120 с.
- `apps/core/src/lab/projects.service.ts` — лимиты из контрактов; finalize:
  сверка magic bytes по типу материала (409 при несоответствии),
  `content_hash = sha256:<hex>` фактических байтов вместо ETag.
- `apps/lab/src/pages/MaterialsCard.tsx` — лимит из контрактов в подсказке и
  проверка размера до запроса билета.
- `scripts/probe-abandoned-uploads.mjs` — +3 живые проверки.

## Статус гейтов (доказательства этой сессии)

| Гейт                             | Результат                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Тесты workspace                  | 377/377 (contracts 41, api-client 16, core 208, БД 112)                                      |
| `smoke-lab` вживую               | 93/93                                                                                        |
| `probe-abandoned-uploads` вживую | 17/17 (+3): sha256 в БД = хеш payload; HTML как PDF → 409; подделка не подтверждена          |
| Журнал                           | `lab.material.added` c `finalized: true`, sizeBytes 48 — новый путь finalize исполнен вживую |
| TypeScript / ESLint / Prettier   | 0 / 0 / чисто                                                                                |
| `gate:boundary`                  | пройден (frontend импортирует только contracts)                                              |
| Сборка `apps/lab`                | успешна (chunk-size warning — известный CODE-MED-03, P2)                                     |
| `gate:net`                       | пройден                                                                                      |

## Findings

| Severity | Где                 | Что                                                              | Статус                                      |
| -------- | ------------------- | ---------------------------------------------------------------- | ------------------------------------------- |
| HIGH     | contracts/lab.ts    | MIME принимался независимо от типа материала (SEC-HIGH-02)       | FIXED                                       |
| HIGH     | projects.service.ts | ETag записывался как content hash (SEC-HIGH-03)                  | FIXED (потоковый sha256)                    |
| HIGH     | projects.service.ts | Содержимое объекта не проверялось вовсе                          | FIXED (magic bytes по типу)                 |
| MEDIUM   | MaterialsCard.tsx   | UI обещал 500 МБ при серверных 50 (CODE-MED-02)                  | FIXED (лимит из контрактов)                 |
| —        | smoke-lab           | Смоук не вызывает finalize — зелёный итог не покрывал новый путь | Закрыто зондом (17/17); отмечено в заметках |

## Ограничения

- Antimalware/CDR/quarantine и авторизованный download-маршрут (остаток
  CODE-HIGH-09/SEC-HIGH-02) требуют парсера и изолированного сканера — это
  внешняя зависимость, зафиксирована в TODO. Magic bytes — проверка формата,
  не вредоносности; это сказано и в коде.
- Существующие подтверждённые материалы сохранили ETag-отпечатки; новые
  подтверждения пишут `sha256:`-префикс — формат различим, пересчёт
  исторических строк не выполнялся (объекты доступны, задача решаема
  отдельным прогоном при необходимости).
