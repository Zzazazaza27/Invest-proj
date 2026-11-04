# Вход файлов `files.5espace.com` — включение на стенде (2.1-W06)

Блок 4, «Вход и файлы MVP». Выполняется на сервере после выпуска кода W06 и
только по слову Томаса. DNS `files.5espace.com → 193.233.217.210` заведён
30.10.2026.

## Что меняется

- Браузер отправляет форму загрузки на `https://files.5espace.com`, ядро ходит
  в MinIO по внутреннему `http://localhost:9000`. Без публичного адреса ядро на
  внешнем стенде форму не выдаёт (отказ «функция недоступна» и запись в журнал).
- `files.5espace.com` принимает только `POST` формы в бакет и `OPTIONS`.
  Остальное — 404: чтение объектов, список бакета, консоль MinIO. Файлы
  читаются через ядро.
- CORS по бакету задаёт Caddy. Общий список MinIO — вторая линия.
- Сроки: форма материала — 95 минут от выдачи. MinIO проверяет срок после
  приёма тела, поэтому в эти 95 минут входят и ожидание начала, и вся
  передача. Caddy принимает тело до 90 минут (`read_body`, на все сайты
  порта 443), браузер ждёт не меньше 90 минут.

## Шаги на сервере

1. Копия: `cp -p /opt/fifth-element/.env /root/backups/env-before-w06-<время>`,
   `cp -p /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-<дата>`.
2. `.env` ядра — дописать:
   - `S3_PUBLIC_ENDPOINT=https://files.5espace.com`
   - `MINIO_CORS_ALLOW_ORIGIN=https://5espace.com,https://test-1.5espace.com`
   - `MATERIAL_UPLOAD_FORM_TTL_SECONDS=5700` (это и значение по умолчанию)
3. MinIO с новым списком CORS: `node scripts/infra.mjs up minio`. Контейнер
   пересоздаётся, данные остаются в томе.
4. Caddyfile:
   - первым блоком файла — глобальные настройки:
     `{ servers { timeouts { read_body 90m } } }`;
   - в конце — `import /opt/fifth-element/infra/caddy/files.caddy`;
   - `caddy validate --config /etc/caddy/Caddyfile`, затем
     `systemctl reload caddy`. Сертификат для `files` Caddy получит сам.
5. `systemctl restart unicorn-core`, health — 200.
6. Проверка входа файлов на сервере:
   `FILES_URL=https://files.5espace.com ALLOWED_ORIGIN=https://5espace.com node scripts/check-files-endpoint.mjs`.
7. Проверка в браузере (её делает человек, входящий в кабинет): PDF стал
   готовым материалом, файл неверного формата отклонён, загрузка, отменённая
   до передачи файла, не опубликована.

## Откат

Вернуть копии `.env` и `Caddyfile`, `systemctl reload caddy`,
`node scripts/infra.mjs up minio`, `systemctl restart unicorn-core`. Без
публичного адреса загрузка из браузера снова недоступна, но теперь с явным
отказом, а не с формой на `localhost`.

## Новая тестовая среда `test-N.5espace.com`

Свой бакет и ключи. В `infra/caddy/files.caddy` — ещё один блок
`handle /<бакет>` по образцу рабочего, со своим Origin. Адрес кабинета —
в `MINIO_CORS_ALLOW_ORIGIN`.
