# Реестр проверок — читаемое представление

> Файл СГЕНЕРИРОВАН из `docs/testing/registry.yaml` командой
> `npm run docs:registry`. Править руками бессмысленно:
> `npm run check:registry` сравнивает его с реестром и краснеет при расхождении.

- Версия реестра: 1, дата 2026-09-22, код `ec550db`
- Обстановка: локальный стенд, Windows, Node 22, PostgreSQL 16
- Проверок: 181; требований: 41

## Что защищено без участия человека

Задания CI: `push`, `static`, `secrets-scan`, `sast`, `deps`, `database`, `unit`, `build`.

- линтер, формат, типы, сборка всех приложений
- миграции и их линтер, тесты схемы БД (9 файлов, 112 проверок)
- девять статических проверок и гейтов (см. runner: ci ниже)

Браузерные прогоны, smoke и probe в CI не запускаются: им нужен поднятый стенд с базой, брокером и хранилищем, которого в CI нет. С 2026-09-28 ci.yml не запускается на push только с Markdown, docs/ (кроме docs/testing/) и obsidian-notes/; секрет-скан вынесен в secrets.yml и идёт на любой push.

Всё остальное запускает человек. Наборы `suite:handoff` и `suite:regression` собирают это в воспроизводимые команды, но запускать их пока обязан Маус — ночной автоматизации нет.

## Наборы

### `npm run suite:handoff` — Перед передачей владельцу

Кто запускает: Маус вручную. Позиций: 8.

- **DBT-ALL** — собирательная позиция
- **CHK-ADMIN-USERS-API** — Раздел «Пользователи» административного кабинета — проверка API.
- **CHK-TESTING-SESSIONS** — Тестовые сессии и контексты доступа — проверка границ доверия.
- **CHK-PROFILE-API** — «Мой профиль» — проверка API (этап 6.4).
- **CHK-CONTENT-TRANSFER** — Проверка переноса подготовленного содержимого целиком.
- **CHK-CONTENT-FRESHNESS** — Актуален ли комплект содержимого в Git относительно базы.
- **CHK-OUTBOUND-BOUNDARIES** — Границы контура наружу: проверяется поведение, а не настройка.
- **CHK-FILE-ACCESS** — Граница доступа к ФАЙЛАМ, а не к строкам в базе.

> Ядро набора фиксировано. Прогоны затронутого кабинета добавляются сверх него по матрице изменений (docs/testing/change-matrix.md); правки общей авторизации, работы с БД и общих компонентов требуют проверки ВСЕХ потребителей, а не одного экрана.

### `npm run suite:regression` — Регрессия перед выкатом или по требованию

Кто запускает: Маус вручную. Позиций: 11.

- **DBT-ALL** — собирательная позиция
- **CHK-ADMIN-USERS-API** — Раздел «Пользователи» административного кабинета — проверка API.
- **CHK-TESTING-SESSIONS** — Тестовые сессии и контексты доступа — проверка границ доверия.
- **CHK-PROFILE-API** — «Мой профиль» — проверка API (этап 6.4).
- **CHK-CONTENT-TRANSFER** — Проверка переноса подготовленного содержимого целиком.
- **CHK-OUTBOUND-BOUNDARIES** — Границы контура наружу: проверяется поведение, а не настройка.
- **CHK-DB-RECONNECT** — Обрыв соединений с базой не роняет ядро.
- **CHK-FILE-ACCESS** — Граница доступа к ФАЙЛАМ, а не к строкам в базе.
- **RND-ADMIN-USERS** — Браузерный проход: раздел «Пользователи» и карточка человека (этап 6.5).
- **RND-TESTING-SESSIONS** — Браузерный проход: тестовые сессии и просмотр кабинета (этап 6.5).
- **RND-PROFILE** — Браузерный проход: «Мой профиль» во всех кабинетах (этап 6.7).

> Браузерные прогоны требуют поднятого стенда (`npm run stand:up`) и переменной `FIFTH_ENTRY=web`.

### `npm run suite:isolated` — Разрушительные проверки в изоляции

Кто запускает: Маус вручную, отдельно от остальных наборов. Позиций: 1.

- **CHK-DB-RESILIENCE** — Живучесть ядра при сбоях базы и брокера — на ОТДЕЛЬНОМ ядре.

> Поднимает СВОЁ ядро на тестовой базе и своём брокере. Рвёт соединения и ограничивает подключения только своей базы; общий брокер стенда не трогает. Восстанавливает зависимости даже при собственном падении.

## Требования: что именно защищено

«Подтверждение» — запускалась ли проверка и когда; её итог хранится в
отчёте запуска (`out/suites/`). «Чувствительность» — отдельное
утверждение: наблюдалась ли проверка КРАСНОЙ без починки.
«Не подтверждено» в последнем столбце не отменяет запуска и не делает
проверку бесполезной — оно значит, что неизвестно, что именно она ловит.

### Доступ

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **ACC-RLS-001** Политики RLS покрывают каждую доменную таблицу, и покрытие нельзя потерять молча | critical | `DBT-RLS` | запущено 2026-09-22 | да (2026-09-21, c219a96) |
| **ACC-RLS-002** Основатель и инвестор не видят чужих проектов; удалённые роли прав не дают | critical | `DBT-RLS`, `SMK-PROJECT-ACCESS` | запущено 2026-09-22 | не подтверждено |
| **ACC-ADMIN-001** Административные маршруты закрыты для всех, кроме администратора | critical | `CHK-ADMIN-USERS-API` | запущено 2026-09-22 | не подтверждено |
| **ACC-CAP-001** Полномочия сотрудника ограничивают действия, а роль администратора проходит их неявно | high | `DBT-STAFF-CAPABILITIES` | прочитано в коде | не подтверждено |
| **ACC-CONTACT-001** Контакты хранятся зашифрованными, показываются маской, раскрытие пишется в журнал | critical | `CHK-ADMIN-USERS-API` | запущено 2026-09-22 | не подтверждено |
| **ACC-CONSOLE-001** Служебная консоль недоступна анониму и не-администратору | critical | `CHK-CONSOLE-PRIVATE`, `RND-CONSOLE` | прочитано в коде | не подтверждено |
| **ACC-FILES-001** Файлы проекта не отдаются тому, кому не виден сам проект, и не достаются мимо ядра | critical | `CHK-FILE-ACCESS`, `SMK-PROJECT-ACCESS`, `SMK-PROJECT-MEDIA` | запущено 2026-09-22 | не подтверждено |
| **GAP-SEARCH-001** Поиск и выгрузки не показывают записи, недоступные по правам | high | `SMK-LAB`, `DBT-INVARIANTS`, `UNIT-CORE-LAB` | запущено 2026-09-22 | не подтверждено |

### Авторизация

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **AUTH-001** Вход, выход и восстановление пароля работают обычным путём | critical | `RND-AUTH`, `SMK-AUTH-RECOVERY` | прочитано в коде | не подтверждено |
| **AUTH-002** Выход и отзыв прав прекращают доступ немедленно, а не по истечении токена | critical | `PRB-TOKEN-REVOCATION`, `PRB-ROLE-REVOCATION`, `CHK-TESTING-SESSIONS` | запущено 2026-09-22 | не подтверждено |
| **AUTH-003** CSRF-защита не ослабляется ни одним режимом работы | critical | `CHK-TESTING-SESSIONS`, `PRB-CSRF-BINDING` | запущено 2026-09-22 | не подтверждено |

### Тестовые сессии

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **TST-CTX-001** Контекст доступа действует только для своего инициатора и только внутри его административной сессии | critical | `CHK-TESTING-SESSIONS` | запущено 2026-09-22 | не подтверждено |
| **TST-CTX-002** Негодный, чужой или отозванный контекст даёт отказ, а не права администратора | critical | `CHK-TESTING-SESSIONS` | запущено 2026-09-22 | не подтверждено |
| **TST-CTX-003** Режим просмотра запрещает изменения на сервере, включая неявные | critical | `CHK-TESTING-SESSIONS`, `RND-TESTING-SESSIONS` | запущено 2026-09-22 | не подтверждено |
| **TST-CTX-004** Режим просмотра всегда виден, а выход из него один | high | `RND-TESTING-SESSIONS` | запущено 2026-09-22 | да (2026-09-22, 43ae5cb) |
| **TST-CLEAN-001** Уборка сессии удаляет только созданное ею и никогда — общие справочники, подготовленное содержимое и рабочие записи | critical | `CHK-TESTING-SESSIONS`, `RND-TESTING-SESSIONS`, `DBT-DATA-CLASSES` | запущено 2026-09-22 | не подтверждено |
| **TST-CLEAN-002** Рабочий пользователь не может стать участником тестовой сессии | critical | `CHK-TESTING-SESSIONS` | запущено 2026-09-22 | да (2026-09-21, c219a96) |

### Надёжность

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **REL-DB-001** Обрыв соединений с базой не завершает процесс ядра | critical | `CHK-DB-RECONNECT`, `CHK-DB-RESILIENCE` | запущено 2026-09-22 | да (2026-09-22, a4167f1) |
| **REL-DB-002** Обрыв ВЫДАННОГО из пула соединения не завершает процесс | critical | `CHK-DB-RESILIENCE` | запущено 2026-09-22 | да (2026-09-22, ec550db) |
| **REL-DB-003** После сбоя база продолжает обслуживаться: событие доходит без перезапуска, не теряется и не задваивает эффект | critical | `CHK-DB-RESILIENCE` | запущено 2026-09-22 | не подтверждено |
| **REL-NATS-001** Уход и возврат брокера не роняют ядро, накопленные события уходят после возврата | high | `CHK-DB-RESILIENCE` | запущено 2026-09-22 | не подтверждено |
| **REL-BG-001** Фоновый таймер не запускает обещаний без перехвата | critical | `CHK-DB-RECONNECT` | запущено 2026-09-22 | да (2026-09-22, 828b12e) |

### Содержимое

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **CNT-001** Подготовленное содержимое переносится между базами без дублей и без потери: словарь, ЧАВО, вопросы, тарифы, страны, шаблоны | critical | `CHK-CONTENT-TRANSFER` | запущено 2026-09-22 | не подтверждено |
| **CNT-002** В комплект содержимого не попадают секреты и данные людей | critical | `CHK-CONTENT-TRANSFER`, `DBT-DATA-CLASSES` | запущено 2026-09-22 | не подтверждено |
| **CNT-003** Каждая таблица отнесена к классу данных, и забыть новую нельзя | high | `DBT-DATA-CLASSES` | запущено 2026-09-22 | да (2026-09-21, f8169ea) |

### Внешние границы

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **EXT-001** Тестовый контур не совершает внешних действий | critical | `CHK-OUTBOUND-BOUNDARIES` | запущено 2026-09-22 | да (2026-09-21, a811e92) |

### Процессы

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **FLOW-LAB-001** Кабинет основателя: проект, видимость, доступ, материалы | high | `RND-LAB`, `SMK-LAB` | прочитано в коде | не подтверждено |
| **FLOW-INVESTOR-001** Кабинет инвестора: оболочка «в разработке»; каталог и избранное по API | high | `RND-INVESTOR`, `SMK-FAVORITES` | прочитано в коде | не подтверждено |
| **FLOW-ADMIN-001** Админка: пользователи, карточка, распоряжение учётной записью | high | `RND-ADMIN-USERS`, `RND-ADMIN`, `CHK-ADMIN-USERS-API` | запущено 2026-09-22 | не подтверждено |
| **FLOW-PROFILE-001** Личный профиль: имя, аватар, смена пароля, отображение проверки личности | medium | `CHK-PROFILE-API`, `RND-PROFILE` | запущено 2026-09-22 | не подтверждено |

### Миграции

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **MIG-001** Миграции применяются на пустую базу и не правятся задним числом | critical | `CI-MIGRATE`, `CI-LINT-MIGRATIONS` | запущено 2026-09-22 | не подтверждено |
| **MIG-002** Функции SECURITY DEFINER не расширяют прав сверх задуманного | critical | `CHK-DEFINER-PRIVILEGES` | запущено 2026-09-22 | не подтверждено |
| **MIG-003** Восстановление из логической копии возвращает данные, политики и целостность журнала | critical | `TOOL-DR-RESTORE-CHECK` | нужен разбор | не подтверждено |

### Архитектура

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **STA-001** Фронтенд не обращается к БД, очередям и хранилищу напрямую | critical | `CHK-FRONTEND-BOUNDARY` | запущено 2026-09-22 | не подтверждено |
| **STA-003** Роли БД и переменные окружения согласованы между собой | high | `CHK-ROLE-ENV-CONSISTENCY`, `CHK-SERVICE-ROLES`, `CHK-PORTS-CONSISTENCY` | запущено 2026-09-22 | не подтверждено |

### Безопасность

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **STA-002** Секреты не попадают в репозиторий и не переиспользуются между контурами | critical | `CHK-SECRET-REUSE`, `CHK-KEK-DOMAINS`, `CHK-SSH-KEYS`, `CHK-CHECKPOINT-SECRETS` | запущено 2026-09-22 | не подтверждено |

### Качество

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **QUA-UNIT-002** Модульные проверки пакетов запускаются автоматикой, а не никем | high | `UNIT-PKG-CONTRACTS-CONTRACTS`, `UNIT-PKG-CONTRACTS-VISIBILITY`, `UNIT-PKG-UI-MARKDOWN`, `UNIT-PKG-API-CLIENT-CLIENT` | запущено 2026-09-22 | не подтверждено |
| **QUA-UNIT-003** Проверки конфигурации задают обстановку сами и не зависят от машины | high | `UNIT-CORE-SECURITY`, `UNIT-CORE-VERIFICATION`, `UNIT-CORE-LAB`, `UNIT-CORE-INTEGRATION` | запущено 2026-09-22 | да (2026-09-22, 9f7c59f) |
| **QUA-UNIT-001** Логика ядра и договоров покрыта модульными проверками | medium | `UNIT-CORE-SECURITY`, `UNIT-CORE-LAB`, `UNIT-CORE-EVENTS`, `UNIT-PKG-CONTRACTS-CONTRACTS`, `UNIT-PKG-CONTRACTS-VISIBILITY` | запущено 2026-09-22 | не подтверждено |

### Целостность

| Требование | Важность | Чем проверено | Подтверждение запуска | Чувствительность |
| --- | --- | --- | --- | --- |
| **CNC-001** Конкурентная запись журнала не рвёт цепочку хешей | critical | `DBT-CONCURRENCY` | запущено 2026-09-22 | не подтверждено |
| **GAP-CONCURRENT-002** Конкурентные действия ВНЕ денежного контура не теряют обновлений | high | `SMK-LAB` | запущено 2026-09-22 | не подтверждено |

## Разделение честности

### Требования без единой проверки — 0

### Зарегистрированы, но ни в наборе, ни в CI — 68

Эти прогоны существуют и работают, но их никто не запускает ни по набору,
ни по расписанию. Зелёный набор о них ничего не говорит.

- `CHK-CHECKPOINT-SECRETS` — Имена, значения которых являются секретами.
- `CHK-CONSOLE-PRIVATE` — Гейт «служебная консоль закрыта постороннему».
- `CHK-BACKUP-LOGIC` — Пригодность копий и сигналы (2.1-W07): разрыв журнала в середине и пропавшая копия-основа не дают READY; подмена файла того же размера ловится описью; измене…
- `CHK-BACKUP-RESTORE` — Восстановление из комплекта на момент T (блок 7, 7.7): комплект ключей открывается закрытым ключом; база восстанавливается pgBackRest на LSN T, транзакция T …
- `CHK-FILES-ENDPOINT` — Вход файлов (2.1-W06): форма подписана на публичный адрес; CORS — разрешённому сайту разрешение, чужому нет, без разрешения на куки; право загрузки держит фо…
- `CHK-FRONT-BUILDS` — Проверка перед выкатом: все фронты собраны в production-режиме.
- `CHK-PORTS-CONSISTENCY` — Гейт согласованности портов стенда.
- `CHK-UPSTREAM-OWNER` — Гейт «в репозиторий коммитит только владелец».
- `CHK-PRE-PUSH` — Быстрая проверка перед отправкой: только файлы, которые уходят в origin.
- `PRB-UPLOAD-COMPLETION` — Приёмка завершения загрузок материалов на общем механизме: аренда, попытки, сверка, отказы и режим отката.
- `PRB-UPLOAD-CANCEL` — Отмена загрузки — состояние «отменено» без удаления: место в квоте освобождено, поздний файл не публикуется ни завершением, ни сверкой, гонка отмены с публик…
- `PRB-CSRF-BINDING` — Проверка привязки CSRF-токена к сессии.
- `PRB-DNS-REBINDING` — Проверка защиты доставки вебхуков от DNS rebinding.
- `PRB-EVENT-ARCHIVE` — Проверка выгрузки журнала событий в холодное хранилище (M041).
- `PRB-EVENT-VERSIONS` — Проверка нумерации версий событий агрегата.
- `PRB-IP-CEILING-TTL` — Проверка того, что потолок частоты по адресу не может «залипнуть» навсегда.
- `PRB-MAIL-READINESS` — Зонд готовности домена к почте: MX, SPF, DKIM, DMARC, PTR и сам релей.
- `PRB-BACKGROUND-JOBS` — Общий механизм фоновой работы ядра — проверка фактом на PostgreSQL и процессах core: аренда, advisory-блокировка, выключатель, роли запуска.
- `PRB-VALKEY-COUNTERS` — Общие счётчики ограничений на Valkey — проверка фактом: окно, обрыв, неизвестный результат, отказ без обхода.
- `PRB-OUTBOX-LEASE` — Проверка очереди outbox: аренда между экземплярами и повтор рассылки.
- `PRB-RATE-LIMIT` — Проверка: обходится ли ограничение частоты подделкой cookie сессии.
- `PRB-ROLE-REVOCATION` — Проверка немедленности отзыва прав.
- `PRB-SECRET-LEAK` — 
- `PRB-SERVICE-TOKEN-EPOCH` — Проверка немедленного отзыва токенов сервисного аккаунта (M042).
- `PRB-SHARED-RATE-LIMIT` — Проверка ОБЩЕГО счётчика ограничения частоты (SEC-11).
- `PRB-TOKEN-REVOCATION` — Проверка точечного отзыва токена (M038).
- `PRB-UPLOAD-QUOTA` — Проверка квот и подтверждения загрузки материалов.
- `RND-ADMIN-COUNTRIES` — Рендер-проверка экрана «Страны обслуживания» в админке (этап 5.6.5).
- `RND-ADMIN-INTELLIGENCE` — Рендер-проверка раздела Market Intelligence (M137–M143).
- `RND-ADMIN` — Проверка административного кабинета в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-AUTH` — Проверка входа и регистрации в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-CONSOLE` — Проверка консоли API в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-DEMO` — Комплект демонстрационных данных в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-FAVORITES` — Избранное инвестора в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-INVESTOR` — Проверка кабинета инвестора в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-LAB` — Проверка кабинета основателя в РЕАЛЬНОМ рендере (`RULES.md` §2): вход настоящей учётной записью, создание проекта, отображение своих проектов, страница проек…
- `RND-MEDIA-EMBEDDING` — Проверка встраивания изображений проекта (7.2, уточнение).
- `RND-PROJECT-MEDIA` — Рендер-проверка логотипа и обложки НА ТЕЛЕФОНЕ (7.2).
- `RND-UPLOAD-OPERATIONS` — Длительные операции в кабинете основателя (2.1-W04, блок 1 1.5): окончательная ошибка — всплывающее сообщение; скрытая вкладка показ не подтверждает, видимая…
- `RND-PROJECT-PAGE` — Рендер-проверка страницы проекта для ТРЁХ зрителей (этап 7.3).
- `RND-SUPPORT` — Поддержка и сообщение об ошибке в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `RND-WEB-PUBLIC` — Проверка витрины в РЕАЛЬНОМ рендере (`RULES.md` §2).
- `TOOL-SECURITY-AUDIT-FULL` — Глобальный аудит: все гейты качества и безопасности одним прогоном.
- `SMK-ADMIN-ROLES` — Живой прогон Ф9c: управление ролями и машиночитаемое описание API.
- `SMK-API-CLIENT` — Проверка соответствия `@fifth/api-client` живому серверу.
- `SMK-AUTH-RECOVERY` — Живой прогон восстановления пароля и подтверждения адреса (Ф51).
- `SMK-CONTENT` — Живой прогон: управление контентом публичной витрины (M048/M049).
- `SMK-CORE` — Дымовая проверка живого core.
- `SMK-DEMO` — Живой прогон: комплект демонстрационных данных.
- `SMK-EVENTS` — Живой прогон Ф9b: публикация событий и доставка вебхуков.
- `SMK-FAVORITES` — Живой прогон: избранные проекты инвестора (M063).
- `SMK-INTEGRATION` — Живой прогон Ф9: Integration API.
- `SMK-LAB` — Живой прогон фазы «KYC и проекты».
- `SMK-MAIL-SMTP` — Живой прогон SMTP-транспорта почты.
- `SMK-PROJECT-ACCESS` — Живой прогон выдачи разрешений выбранным получателям (этап 5.8).
- `SMK-PROJECT-MEDIA` — Живой прогон логотипа и обложки проекта (7.2).
- `SMK-SUPPORT` — Живой прогон: поддержка пользователей и сообщения об ошибках (M062).
- `CHK-MONITOR-PROBE-DISABLE` — Отключение учётки мониторинга подтверждается только ожидаемыми ответами: вход — 403 forbidden при статусе suspended в базе, сессия — 401 unauthenticated; 429…
- `CHK-MONITOR-PULSE` — Свежесть контрольной отметки Zabbix для пульса: свежая и на пороге — да; устаревшая, из будущего сверх допуска 60 с, пустая, нулевая, не число, дробная — отказ.
- `CHK-DNS-HIDDEN-PRIMARY` — Схема «скрытый первичный + вторичные» на тестовой зоне (план независимого DNS): передача зоны только по ключу и с адреса вторичного, обновление по NOTIFY, от…
- `CHK-DNS-PRIMARY-APPLY` — Безопасное применение зон первичного DNS: неверная зона отклоняется, рабочий файл и записанная версия не меняются, после перезапуска работает прежняя зона; с…
- `CHK-MONITOR-APP-PROBE` — Разрешённое чтение контрольных данных прикладным путём (2.5, 8.2): обычный вход служебной учётки через публичный адрес, карточка контрольного проекта и матер…
- `CHK-RELEASE-PINS` — Очистка не удаляет комплект, образы которого могут работать в среде.
- `CHK-RELEASE` — Блок 9, задание 1: комплект, блокировка, реестр и сверка версий.
- `CHK-ENV-ISOLATION` — Комплект запускается в разных изолированных средах без правки кода и Compose.
- `CHK-LOGS-ARCHIVE` — Архиватор журналов на настоящем journald (8.4, 2.1-W08b): бакет и учётки — настоящим minio-init по infra/minio/policies; учётка записи пишет, но не удаляет о…
- `CHK-LOGS-APPLY` — Применение W08b (8.4) без VPS: юниты fifth-logs-run/files/pack из infra/systemd проходят systemd-analyze verify и работают с окружением из .env (LOGS_DOTENV)…
- `CHK-MONITORING-ACCOUNT` — Служебная учётка мониторинга — только чтение контрольных данных (2.5): контрольные карточка и файл читаются; изменение и чтение профиля, загрузка и удаление …

### Намеренно вручную — 9

- **PRB-MAIL-DELIVERY** — Отправляет НАСТОЯЩЕЕ письмо через реальный релей живому получателю. Действие уходит наружу и не отзывается, поэтому прогон выведен из всех функциональных блоков: запускается только руками, с явным получателем в --to и подтверждением MAIL_PROBE_CONFIRM=1, по прямому решению владельца.
- **TOOL-DR-RESTORE-CHECK** — Снимает полную копию базы и разворачивает её в отдельную базу. Долго и тяжело; запускается перед выкатом и при изменениях схемы хранения.
- **TOOL-LOAD-TEST** — Нагрузочный прогон. Создаёт много записей и искажает замеры соседних проверок; по решению владельца в общие наборы не входит.
- **TOOL-SEED-DEMO** — Загрузка демонстрационного комплекта — подготовка данных, не проверка.
- **TOOL-SEED-ACCEPTANCE** — Обстановка приёмки — подготовка данных, не проверка.
- **TOOL-CLEAN-PROBE-DATA** — Уборка следов прогонов — обслуживание, вызывается по поводу.
- **TOOL-DB-BACKUP** — Копия базы перед опасной работой — операция, а не проверка.
- **TOOL-INFRA** — Управление контурами стенда, включая сброс данных. Запускается только по прямому решению владельца и никогда автоматически.
- **TOOL-RESET-TEST-DB** — Полностью очищает базу. Разрушительна по назначению; вызывается в порядке чистого развёртывания.

## Полный перечень проверок

### Инструменты (не проверки)

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| TOOL-ARCHIVE-EVENTS | `node scripts/archive-events.mjs` | 0 | вручную, по поводу | — |
| TOOL-BACKFILL-MATERIAL-SIZES | `node scripts/backfill-material-sizes.mjs` | 0 | вручную, по поводу | — |
| TOOL-BUILD-TEST-REGISTRY-DOC | `npm run docs:registry` | 0 | вручную, по поводу | — |
| TOOL-BUILD-LOCAL-REDACTORS | `npm run secrets:redactors` | 0 | вручную, по поводу | — |
| TOOL-PROBE-RESIDUE | `node scripts/probe-residue.mjs` | 0 | вручную, по поводу | — |
| TOOL-CLEAN-PROBE-DATA | `npm run stand:clean-probes` | 0 | вручную, по поводу | — |
| TOOL-CONTENT-SNAPSHOT | `npm run content:export` | 0 | вручную, по поводу | — |
| TOOL-BACKUP | `node scripts/backup.mjs init-secrets|keys-init|db|set|check|status|pull` | 0 | вручную, по поводу | — |
| TOOL-DB-BACKUP | `npm run db:backup` | 0 | вручную, по поводу | — |
| TOOL-DEPLOY | `npm run deploy` | 0 | вручную, по поводу | — |
| TOOL-DEV-CORE | `node scripts/dev-core.mjs` | 0 | вручную, по поводу | — |
| TOOL-DEV-MAKE-ADMIN | `node scripts/dev-make-admin.mjs` | 0 | вручную, по поводу | — |
| TOOL-DEV-REMOVE-TEST-USER | `node scripts/dev-remove-test-user.mjs` | 0 | вручную, по поводу | — |
| TOOL-DEV-SEED-TEST-USER | `node scripts/dev-seed-test-user.mjs` | 0 | вручную, по поводу | — |
| TOOL-DR-RESTORE-CHECK | `node scripts/dr-restore-check.mjs` | 17 | вручную, по поводу | — |
| TOOL-FIX-DOCKER-SOCKET | `npm run session` | 0 | вручную, по поводу | — |
| TOOL-INFRA | `npm run infra:up` | 0 | вручную, по поводу | — |
| TOOL-LOAD-TEST | `node scripts/load-test.mjs` | 0 | вручную, по поводу | — |
| TOOL-NATS-INIT-STREAM | `node scripts/nats-init-stream.mjs` | 0 | вручную, по поводу | — |
| TOOL-WIPE-STAND-DATA | `node --experimental-strip-types scripts/wipe-stand-data.mjs truncate` | 0 | вручную, по поводу | — |
| TOOL-PURGE-EVENT-STREAM | `node scripts/purge-event-stream.mjs` | 0 | вручную, по поводу | — |
| TOOL-STAND-SERVICE-ACCOUNTS | `node scripts/stand-service-accounts.mjs <platform> <admin>` | 0 | вручную, по поводу | — |
| TOOL-LIST-KEPT-DATA | `node --experimental-strip-types scripts/list-kept-data.mjs` | 0 | вручную, по поводу | — |
| TOOL-RESET-TEST-DB | `node scripts/reset-test-db.mjs` | 0 | вручную, по поводу | — |
| TOOL-ROTATE-KEK | `npm run rotate:kek` | 0 | вручную, по поводу | — |
| TOOL-ROTATE-STAND-SECRETS | `npm run rotate:stand-secrets` | 0 | вручную, по поводу | — |
| TOOL-S3-LIFECYCLE-APPLY | `node scripts/s3-lifecycle-apply.mjs` | 0 | вручную, по поводу | — |
| TOOL-SEED-ACCEPTANCE | `node scripts/seed-acceptance.mjs` | 0 | вручную, по поводу | — |
| TOOL-RUN-SUITE | `npm run suite:handoff` | 0 | вручную, по поводу | — |
| TOOL-INTEL-VERIFY-PAGES | `node scripts/intelligence-verify-pages.mjs` | 0 | вручную, по поводу | — |
| TOOL-INTEL-INGEST | `node scripts/intelligence-ingest.mjs` | 0 | вручную, по поводу | — |
| TOOL-INTEL-LOAD-RESEARCH | `node scripts/intelligence-load-research.mjs` | 0 | вручную, по поводу | — |
| TOOL-SEED-DEMO | `npm run demo:load` | 0 | вручную, по поводу | — |
| TOOL-STAND-CHECK | `npm run stand:status` | 0 | вручную, по поводу | — |
| TOOL-STAND-DOWN | `npm run stand:down` | 0 | вручную, по поводу | — |
| TOOL-STAND-STATUS | `npm run session` | 0 | вручную, по поводу | — |
| TOOL-STAND-UP | `npm run stand:up` | 2 | вручную, по поводу | — |
| TOOL-TEMP-STAND | `npm run temp:up` | 0 | вручную, по поводу | — |
| TOOL-TEMP-RUN | `npm run temp:run` | 0 | вручную, по поводу | — |
| TOOL-VITE-BUILD | `node scripts/vite-build.mjs` | 0 | вручную, по поводу | — |
| TOOL-KIT | `node scripts/kit.mjs manifest|fetch|pack|load|check --build <номер>` | 0 | вручную, по поводу | — |
| TOOL-RELEASE | `node scripts/release.mjs install|verify|replay|recover <среда>` | 0 | вручную, по поводу | — |
| TOOL-RENAME-STAND | `node scripts/rename-stand.mjs copy|back` | 0 | вручную, по поводу | — |
| TOOL-ENV | `node scripts/env.mjs create|status|stop|start|seed|destroy <среда>` | 0 | вручную, по поводу | — |
| TOOL-LOGS-ARCHIVE | `node scripts/logs-archive.mjs init|run|rebuild|status|verify|pack|pull --to <каталог>|verify-copy --to <каталог>|find --from <ISO> [...]|files|legacy-export|legacy-snapshot|legacy-gap|secrets-draft --to <файл>` | 0 | вручную, по поводу | — |
| TOOL-GARAGE-INIT | `node scripts/garage-init.mjs [--status]` | 0 | вручную, по поводу | — |
| TOOL-MONITORING | `node scripts/monitoring.mjs configure|status [--items]` | 0 | вручную, по поводу | — |
| TOOL-MONITOR-PROBE-DISABLE | `node scripts/monitor-probe-disable.mjs` | 0 | вручную, по поводу | — |
| TOOL-MONITOR-PULSE | `node scripts/monitor-pulse.mjs` | 0 | вручную, по поводу | — |
| TOOL-DNS-PRIMARY | `node scripts/dns-primary.mjs up` | 0 | вручную, по поводу | — |
| TOOL-MONITOR-PROBE-INIT | `node scripts/monitor-probe-init.mjs` | 0 | вручную, по поводу | — |
| TOOL-MONITOR-EXPORT | `node scripts/monitor-export.mjs` | 0 | вручную, по поводу | — |

### Проверки поведения (`check-*`)

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| CHK-ADMIN-USERS-API | `node scripts/check-admin-users-api.mjs` | 46 | вручную | `suite:handoff`, `suite:regression` |
| CHK-CHECKPOINT-SECRETS | `npm run gate:checkpoint-secrets` | 0 | вручную | — |
| CHK-CONSOLE-PRIVATE | `npm run gate:console-private` | 0 | вручную | — |
| CHK-CONTENT-FRESHNESS | `npm run check:content-freshness` | 2 | вручную | `suite:handoff` |
| CHK-CONTENT-TRANSFER | `npm run check:content-transfer` | 16 | вручную | `suite:handoff`, `suite:regression` |
| CHK-DB-RECONNECT | `npm run check:db-reconnect` | 8 | вручную | `suite:regression` |
| CHK-DB-RESILIENCE | `npm run check:db-resilience` | 23 | вручную | `suite:isolated` |
| CHK-DEFINER-PRIVILEGES | `node scripts/check-definer-privileges.mjs` | 0 | CI | CI |
| CHK-BACKUP-LOGIC | `node scripts/check-backup-logic.mjs` | 33 | вручную | — |
| CHK-BACKUP-RESTORE | `node scripts/check-backup-restore.mjs [--from <скачанный комплект>] [--secret-key <файл>] [--passphrase-file <файл>]` | 21 | вручную | — |
| CHK-FILES-ENDPOINT | `FILES_URL=<публичный адрес> ALLOWED_ORIGIN=<сайт кабинета> node scripts/check-files-endpoint.mjs` | 27 | вручную | — |
| CHK-FILE-ACCESS | `npm run check:file-access` | 18 | вручную | `suite:handoff`, `suite:regression` |
| CHK-FRONT-BUILDS | `npm run check:front-builds` | 0 | вручную | — |
| CHK-FRONTEND-BOUNDARY | `npm run gate:boundary` | 0 | CI | CI |
| CHK-KEK-DOMAINS | `npm run gate:kek` | 0 | CI | CI |
| CHK-OUTBOUND-BOUNDARIES | `npm run check:outbound` | 7 | вручную | `suite:handoff`, `suite:regression` |
| CHK-PORTS-CONSISTENCY | `npm run gate:ports` | 0 | вручную | — |
| CHK-PROFILE-API | `node scripts/check-profile-api.mjs` | 30 | вручную | `suite:handoff`, `suite:regression` |
| CHK-ROLE-ENV-CONSISTENCY | `npm run gate:roles-env` | 0 | CI | CI |
| CHK-SAST-CONFIG | `npm run gate:sast-config` | 0 | CI | CI |
| CHK-SECRET-REUSE | `npm run gate:secret-reuse` | 0 | CI | CI |
| CHK-SERVICE-ROLES | `node scripts/check-service-roles.mjs` | 40 | CI | CI |
| CHK-DEPLOY-RELEASE | `npm run check:deploy-release` | 98 | CI | CI |
| CHK-SSH-KEYS | `npm run gate:ssh-keys` | 0 | CI | CI |
| CHK-TEST-REGISTRY | `npm run check:registry` | 12 | CI | CI |
| CHK-TESTING-SESSIONS | `npm run check:testing-sessions` | 49 | вручную | `suite:handoff`, `suite:regression` |
| CHK-UPSTREAM-OWNER | `npm run session` | 0 | вручную | — |
| CHK-PRE-PUSH | `npm run gate:pre-push` | 0 | вручную | — |
| CHK-MONITOR-PROBE-DISABLE | `node scripts/check-monitor-probe-disable.mjs` | 14 | вручную | — |
| CHK-MONITOR-PULSE | `node scripts/check-monitor-pulse.mjs` | 12 | вручную | — |
| CHK-DNS-HIDDEN-PRIMARY | `node scripts/check-dns-hidden-primary.mjs` | 14 | вручную | — |
| CHK-DNS-PRIMARY-APPLY | `node scripts/check-dns-primary-apply.mjs` | 16 | вручную | — |
| CHK-MONITOR-APP-PROBE | `node scripts/monitor-app-probe.mjs` | 4 | вручную | — |
| CHK-RELEASE-PINS | `node scripts/check-release-pins.mjs` | 21 | вручную | — |
| CHK-RELEASE | `node scripts/check-release.mjs` | 53 | вручную | — |
| CHK-ENV-ISOLATION | `node scripts/check-env-isolation.mjs` | 41 | вручную | — |
| CHK-LOGS-ARCHIVE | `node scripts/check-logs-archive.mjs` | 228 | вручную | — |
| CHK-LOGS-APPLY | `node scripts/check-logs-apply.mjs` | 36 | вручную | — |
| CHK-MONITORING-ACCOUNT | `node scripts/check-monitoring-account.mjs` | 9 | вручную | — |

### Гейты и статические проверки

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| TOOL-NETWORK-AUDIT | `npm run gate:net` | 15 | CI | CI |
| TOOL-SECURITY-AUDIT-FULL | `node scripts/security-audit-full.mjs` | 0 | вручную, по поводу | — |

### Пробы (`probe-*`)

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| PRB-UPLOAD-COMPLETION | `node scripts/probe-upload-completion.mjs` | 55 | вручную | — |
| PRB-UPLOAD-CANCEL | `node scripts/probe-upload-cancel.mjs` | 48 | вручную | — |
| PRB-CSRF-BINDING | `node scripts/probe-csrf-binding.mjs` | 6 | вручную | — |
| PRB-DNS-REBINDING | `node scripts/probe-dns-rebinding.mjs` | 6 | вручную | — |
| PRB-EVENT-ARCHIVE | `node scripts/probe-event-archive.mjs` | 11 | вручную | — |
| PRB-EVENT-VERSIONS | `node scripts/probe-event-versions.mjs` | 7 | вручную | — |
| PRB-IP-CEILING-TTL | `node scripts/probe-ip-ceiling-ttl.mjs` | 9 | вручную | — |
| PRB-MAIL-DELIVERY | `node scripts/probe-mail-delivery.mjs` | 0 | вручную | — |
| PRB-MAIL-READINESS | `node scripts/probe-mail-readiness.mjs` | 0 | вручную | — |
| PRB-BACKGROUND-JOBS | `node scripts/probe-background-jobs.mjs` | 45 | вручную | — |
| PRB-VALKEY-COUNTERS | `node scripts/probe-valkey-counters.mjs` | 15 | вручную | — |
| PRB-OUTBOX-LEASE | `node scripts/probe-outbox-lease.mjs` | 10 | вручную | — |
| PRB-RATE-LIMIT | `node scripts/probe-rate-limit.mjs` | 0 | вручную | — |
| PRB-ROLE-REVOCATION | `node scripts/probe-role-revocation.mjs` | 5 | вручную | — |
| PRB-SECRET-LEAK | `npm run probe:secret-leak` | 0 | вручную | — |
| PRB-SERVICE-TOKEN-EPOCH | `node scripts/probe-service-token-epoch.mjs` | 9 | вручную | — |
| PRB-SHARED-RATE-LIMIT | `node scripts/probe-shared-rate-limit.mjs` | 10 | вручную | — |
| PRB-TOKEN-REVOCATION | `node scripts/probe-token-revocation.mjs` | 23 | вручную | — |
| PRB-UPLOAD-QUOTA | `node scripts/probe-upload-quota.mjs` | 13 | вручную | — |

### Браузерные проходы (`render-check-*`)

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| RND-ADMIN-COUNTRIES | `npm run temp:run -- scripts/render-check-admin-countries.mjs` | 12 | вручную | временный контур · — |
| RND-ADMIN-INTELLIGENCE | `FIFTH_ENTRY=web node scripts/render-check-admin-intelligence.mjs` | 27 | вручную | — |
| RND-ADMIN-USERS | `node scripts/render-check-admin-users.mjs` | 40 | вручную | `suite:regression` |
| RND-ADMIN | `node scripts/render-check-admin.mjs` | 32 | вручную | — |
| RND-AUTH | `node scripts/render-check-auth.mjs` | 26 | вручную | — |
| RND-CONSOLE | `node scripts/render-check-console.mjs` | 14 | вручную | — |
| RND-DEMO | `node scripts/render-check-demo.mjs` | 8 | вручную | — |
| RND-FAVORITES | `node scripts/render-check-favorites.mjs` | 17 | вручную | — |
| RND-INVESTOR | `node scripts/render-check-investor.mjs` | 13 | вручную | — |
| RND-LAB | `node scripts/render-check-lab.mjs` | 33 | вручную | — |
| RND-MEDIA-EMBEDDING | `node scripts/render-check-media-embedding.mjs` | 12 | вручную | — |
| RND-PROFILE | `node scripts/render-check-profile.mjs` | 17 | вручную | `suite:regression` |
| RND-PROJECT-MEDIA | `node scripts/render-check-project-media.mjs` | 16 | вручную | — |
| RND-UPLOAD-OPERATIONS | `FIFTH_ENTRY=web node scripts/render-check-upload-operations.mjs` | 48 | вручную | — |
| RND-PROJECT-PAGE | `node scripts/render-check-project-page.mjs` | 15 | вручную | — |
| RND-SUPPORT | `node scripts/render-check-support.mjs` | 26 | вручную | — |
| RND-TESTING-SESSIONS | `node scripts/render-check-testing-sessions.mjs` | 27 | вручную | `suite:regression` |
| RND-WEB-PUBLIC | `node scripts/render-check-web-public.mjs` | 14 | вручную | — |

### Дымовые проходы (`smoke-*`)

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| SMK-ADMIN-ROLES | `node scripts/smoke-admin-roles.mjs` | 28 | вручную | — |
| SMK-API-CLIENT | `node scripts/smoke-api-client.mjs` | 12 | вручную | — |
| SMK-AUTH-RECOVERY | `node scripts/smoke-auth-recovery.mjs` | 35 | вручную | — |
| SMK-CONTENT | `node scripts/smoke-content.mjs` | 19 | вручную | — |
| SMK-CORE | `node scripts/smoke-core.mjs` | 44 | вручную | — |
| SMK-DEMO | `node scripts/smoke-demo.mjs` | 39 | вручную | — |
| SMK-EVENTS | `node scripts/smoke-events.mjs` | 27 | вручную | — |
| SMK-FAVORITES | `node scripts/smoke-favorites.mjs` | 28 | вручную | — |
| SMK-INTEGRATION | `node scripts/smoke-integration.mjs` | 38 | вручную | — |
| SMK-LAB | `node scripts/smoke-lab.mjs` | 112 | вручную | — |
| SMK-MAIL-SMTP | `node scripts/smoke-mail-smtp.mjs` | 13 | вручную | — |
| SMK-PROJECT-ACCESS | `node scripts/smoke-project-access.mjs` | 41 | вручную | — |
| SMK-PROJECT-MEDIA | `node scripts/smoke-project-media.mjs` | 32 | вручную | — |
| SMK-SUPPORT | `node scripts/smoke-support.mjs` | 44 | вручную | — |

### Тесты схемы базы

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| DBT-ACCESS-PATHS | `npm run test -w database` | 4 | CI | CI |
| DBT-OPERATIONS | `npm run test -w database` | 10 | CI | CI |
| DBT-CONCURRENCY | `npm run test -w database` | 1 | CI | CI |
| DBT-DATA-CLASSES | `npm run test -w database` | 7 | CI | CI |
| DBT-INVARIANTS | `npm run test -w database` | 28 | CI | CI |
| DBT-PROJECT-ACCESS-DIRECTORY | `npm run test -w database` | 4 | CI | CI |
| DBT-PROJECT-ACCESS | `npm run test -w database` | 11 | CI | CI |
| DBT-PROJECT-VIEWS | `npm run test -w database` | 2 | CI | CI |
| DBT-RLS | `npm run test -w database` | 48 | CI | CI |
| DBT-STAFF-CAPABILITIES | `npm run test -w database` | 4 | CI | CI |

### Задания CI

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| CI-LINT | `npm run lint` | 0 | CI | CI |
| CI-FORMAT | `npm run format:check` | 0 | CI | CI |
| CI-TYPES | `npm run typecheck` | 0 | CI | CI |
| CI-BUILD | `npm run build` | 0 | CI | CI |
| CI-MIGRATE | `npm run db:migrate` | 0 | CI | CI |
| CI-LINT-MIGRATIONS | `npm run lint:migrations -w database` | 0 | CI | CI |
| CI-SAST | `semgrep (задание sast)` | 0 | CI | CI |
| CI-SECRETS | `gitleaks (задание secrets-scan)` | 0 | CI | CI |

### unit-test

| Идентификатор | Команда | Утверждений | Кто запускает | Где запускается |
| --- | --- | --- | --- | --- |
| UNIT-CORE-PLATFORM-FLAGS | `npm run test -w apps/core` | 1 | CI | CI |
| UNIT-CORE-BACKGROUND | `npm run test -w apps/core` | 18 | CI | CI |
| UNIT-CORE-UPLOAD-ADDRESS | `npm run test -w apps/core` | 10 | CI | CI |
| UNIT-CORE-READINESS | `npm run test -w apps/core` | 14 | CI | CI |
| UNIT-CORE-MONITORING-ACCOUNT | `npm run test -w apps/core` | 6 | CI | CI |
| UNIT-CORE-SAFE-LOG | `npm run test -w apps/core` | 24 | CI | CI |
| UNIT-CORE-COUNTERS | `npm run test -w apps/core` | 8 | CI | CI |
| UNIT-CORE-UPLOAD-COMPLETION | `npm run test -w apps/core` | 6 | CI | CI |
| UNIT-CORE-EVENTS | `npm run test -w apps/core` | 24 | CI | CI |
| UNIT-CORE-INTEGRATION | `npm run test -w apps/core` | 15 | CI | CI |
| UNIT-CORE-LAB | `npm run test -w apps/core` | 21 | CI | CI |
| UNIT-CORE-SECURITY | `npm run test -w apps/core` | 64 | CI | CI |
| UNIT-CORE-TECHDEBT | `npm run test -w apps/core` | 8 | CI | CI |
| UNIT-CORE-VERIFICATION | `npm run test -w apps/core` | 14 | CI | CI |
| UNIT-CORE-SECRET-FILES | `npm run test -w apps/core` | 11 | CI | CI |
| UNIT-PKG-API-CLIENT-CLIENT | `npm run test -w packages/api-client` | 17 | CI | CI |
| UNIT-PKG-CONTRACTS-CONTRACTS | `npm run test -w packages/contracts` | 25 | CI | CI |
| UNIT-PKG-CONTRACTS-VISIBILITY | `npm run test -w packages/contracts` | 10 | CI | CI |
| UNIT-PKG-UI-MARKDOWN | `npm run test -w packages/ui` | 10 | CI | CI |

