-- =============================================================================
-- M041 — реестр выгрузок журнала событий в холодное хранилище
--
-- Закрывает эксплуатационный пункт «архив событий старше 90 дней уезжает в
-- холодное хранилище отдельной процедурой»: сама процедура — скрипт
-- `scripts/archive-events.mjs`, а здесь появляется то, без чего она была бы
-- ненаблюдаемой — след каждой выгрузки.
--
-- Что реестр НЕ делает: он не удаляет события. Выгрузка — только копирование.
-- Срок хранения журнала для оператора инвестиционной платформы определяется
-- законом и Правилами платформы, а не удобством эксплуатации; решение об
-- удалении принимает владелец, и оно потребует отдельной миграции с явным
-- основанием. Выгрузка без удаления полезна и сама по себе: она даёт копию вне
-- основной БД.
--
-- Реестр append-only по той же причине, что и сам журнал: запись о том, что
-- выгрузка была, не должна редактироваться задним числом. UPDATE и DELETE не
-- выдаются никому, включая роль приложения.
-- =============================================================================

CREATE TABLE IF NOT EXISTS audit.event_archives (
    id             UUID PRIMARY KEY DEFAULT public.uuid_generate_v7(),
    -- Границы выгруженного диапазона по времени события.
    period_start   TIMESTAMPTZ NOT NULL,
    period_end     TIMESTAMPTZ NOT NULL,
    -- Ключ объекта в хранилище. Уникален: повторная выгрузка того же диапазона
    -- обязана либо создать новый объект, либо честно упасть.
    object_key     TEXT NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 8 AND 512),
    event_count    BIGINT NOT NULL CHECK (event_count >= 0),
    -- Отпечаток выгруженного файла: по нему проверяется, что в хранилище лежит
    -- ровно то, что было прочитано из журнала.
    sha256         TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- Границы цепочки в выгрузке: по ним видно, к какому месту журнала
    -- относится файл, без чтения самого файла.
    first_event_id UUID,
    last_event_id  UUID,
    -- Результат сверки hash-chain НА МОМЕНТ выгрузки. Копия, снятая с
    -- повреждённой цепочки, обязана быть отмечена как таковая, а не выглядеть
    -- полноценным архивом.
    chain_intact   BOOLEAN NOT NULL,
    exported_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (period_end > period_start)
);

COMMENT ON TABLE audit.event_archives IS
    'След выгрузок журнала событий в холодное хранилище. Только копирование: '
    'события из audit.events не удаляются (M041).';
COMMENT ON COLUMN audit.event_archives.chain_intact IS
    'Была ли hash-chain цела на момент выгрузки. false означает, что копия '
    'снята с повреждённой цепочки и доказательством целостности не является.';

CREATE INDEX IF NOT EXISTS event_archives_period ON audit.event_archives (period_start);

ALTER TABLE audit.event_archives ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.event_archives FORCE ROW LEVEL SECURITY;

-- Читать след выгрузок может администратор: это эксплуатационная информация,
-- а не пользовательская. Писать — никто из ролей приложения: выгрузку
-- выполняет оператор своим подключением, как и положено процедуре, которая
-- имеет доступ ко всему журналу.
CREATE POLICY event_archives_admin_read ON audit.event_archives FOR SELECT TO app_backend
    USING (app.has_role('admin'));

GRANT SELECT ON audit.event_archives TO app_backend;
