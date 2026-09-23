-- M144 — метка обхода площадки краулером.
--
-- Решение владельца 2026-09-23: площадку (сайт или Telegram-канал) можно
-- пометить для регулярного обхода по правилу — как часто и что снимать.
-- Сам краулер и рассылка анонсов — отдельная работа; здесь только метка,
-- по которой он будет выбирать площадки.
--
--  * crawl_mode    — off (не обходить), daily, weekly.
--  * crawl_extract — что снимать при обходе: анонсы событий, жюри, спикеры,
--    сделки, портфель, команда, календарь, каталог участников.
--  * crawl_rule    — правило словами: какой раздел или какие посты читать,
--    на что смотреть. Пока читает человек, потом — краулер.
ALTER TABLE intelligence.sources
    ADD COLUMN crawl_mode    TEXT   NOT NULL DEFAULT 'off'
        CHECK (crawl_mode IN ('off', 'daily', 'weekly')),
    ADD COLUMN crawl_extract TEXT[] NOT NULL DEFAULT '{}'
        CHECK (crawl_extract <@ ARRAY['announcements', 'jury', 'speakers', 'deals',
                                      'portfolio', 'team', 'calendar', 'catalog']::TEXT[]),
    ADD COLUMN crawl_rule    TEXT;

COMMENT ON COLUMN intelligence.sources.crawl_mode IS
    'Регулярный обход краулером: off — нет, daily — ежедневно, weekly — еженедельно.';
COMMENT ON COLUMN intelligence.sources.crawl_extract IS
    'Что снимать при обходе: announcements, jury, speakers, deals, portfolio, team, '
    'calendar, catalog.';
COMMENT ON COLUMN intelligence.sources.crawl_rule IS
    'Правило обхода словами: какой раздел или какие посты читать и что заносить в базу.';

CREATE INDEX sources_crawl_idx ON intelligence.sources (crawl_mode)
    WHERE crawl_mode <> 'off';
