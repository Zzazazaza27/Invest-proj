-- M163 — группа функций «События и интеграции» (блок 4, 4.11; пакет 5 раздела 01, 08.11.2026).
--
-- 1. Наблюдения и ручные ограничения принимают группу `events`. В группе два независимых
--    контура: публикация outbox в брокер и доставка вебхуков. Ручной запрет группы
--    останавливает оба; автоматические ограничения — каждый свой.
--
-- 2. Узел назначения подписки (`destination`) — нормализованные «хост:порт» адреса: три
--    подписки на один адрес — один получатель. Вычисляется из `url` и не расходится с ним.
--
-- 3. Пауза по получателю (`integration.webhook_destinations`): после отказа доставки на узел
--    его остальные доставки ждут без расхода попыток; по истечении паузы одна пробная
--    доставка под арендой пробы (`probe_lease_id`) проверяет адрес. Успех снимает паузу
--    (строка удаляется), повторный отказ удваивает её до предела. Состояние в БД: переживает
--    перезапуск, а условие аренды пробы не даёт двум исполнителям проверять один адрес.

-- ------------------------------------------------------------------ 1. группа «События»
ALTER TABLE availability.observations DROP CONSTRAINT observations_group_id_check;
ALTER TABLE availability.observations
    ADD CONSTRAINT observations_group_id_check CHECK (group_id IN ('files', 'mail', 'events'));
ALTER TABLE availability.restrictions DROP CONSTRAINT restrictions_group_id_check;
ALTER TABLE availability.restrictions
    ADD CONSTRAINT restrictions_group_id_check CHECK (group_id IN ('files', 'mail', 'events'));

-- ------------------------------------------------------------ 2. узел назначения подписки
-- Хост в нижнем регистре и порт; без порта — 443 (подписки только https, M010).
ALTER TABLE integration.webhook_endpoints
    ADD COLUMN destination TEXT GENERATED ALWAYS AS (
        CASE
            WHEN lower(substring(url FROM '^[Hh][Tt][Tt][Pp][Ss]://([^/?#]+)')) ~ ':[0-9]+$'
                THEN lower(substring(url FROM '^[Hh][Tt][Tt][Pp][Ss]://([^/?#]+)'))
            ELSE lower(substring(url FROM '^[Hh][Tt][Tt][Pp][Ss]://([^/?#]+)')) || ':443'
        END
    ) STORED;

CREATE INDEX webhook_endpoints_destination ON integration.webhook_endpoints (destination);

COMMENT ON COLUMN integration.webhook_endpoints.destination IS
    'Узел назначения «хост:порт» (4.11, M163): единица паузы по получателю и общего сигнала.';

-- --------------------------------------------------------------- 3. пауза по получателю
CREATE TABLE integration.webhook_destinations (
    destination       TEXT        PRIMARY KEY CHECK (length(destination) BETWEEN 3 AND 300),
    failures          INTEGER     NOT NULL DEFAULT 0 CHECK (failures >= 0),
    pause_seconds     INTEGER     NOT NULL CHECK (pause_seconds > 0),
    paused_until      TIMESTAMPTZ NOT NULL,
    -- Аренда пробы: новый идентификатор на каждый захват (как M160).
    probe_lease_id    UUID,
    probe_until       TIMESTAMPTZ,
    -- receiver — ответ или отказ получателя; transport — сеть до получателя; unknown — тело
    -- передано, ответа нет (это не подтверждённый отказ получателя).
    last_failure_kind TEXT        NOT NULL CHECK (last_failure_kind IN
                          ('receiver', 'transport', 'unknown')),
    last_failure_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((probe_lease_id IS NULL) = (probe_until IS NULL))
);

COMMENT ON TABLE integration.webhook_destinations IS
    'Пауза доставки по узлу назначения (4.11, M163): есть строка — узел на паузе или под пробой.';

ALTER TABLE integration.webhook_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration.webhook_destinations FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON integration.webhook_destinations TO app_integration;
GRANT SELECT ON integration.webhook_destinations TO app_readonly;

CREATE POLICY webhook_destinations_service ON integration.webhook_destinations
    FOR ALL TO app_integration USING (true) WITH CHECK (true);
CREATE POLICY webhook_destinations_read ON integration.webhook_destinations
    FOR SELECT TO app_readonly USING (true);
