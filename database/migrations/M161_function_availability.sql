-- M161 — доступность групп функций (блок 4, 4.11; первая группа — «Файлы»).
--
-- Две таблицы:
--   * observations — результаты служебных проверок зависимостей: экземпляр, группа, режим
--     (чтение/запись), исход, безопасный код причины, время и предел актуальности.
--     Остановленный экземпляр помечается и в сведение не входит; просроченное наблюдение
--     доступности не даёт.
--   * restrictions — ручные ограничения эксплуатации, отдельно от продуктовых флагов
--     (audit.feature_flags). Менять — только с полномочием `ops.availability.update`;
--     действующее лицо, причина и изменение пишутся в журнал действий. Заметка сотрудника
--     наружу не отдаётся: публично — только код причины.

CREATE SCHEMA availability;

CREATE TABLE availability.observations (
    instance    TEXT        NOT NULL CHECK (length(instance) BETWEEN 1 AND 200),
    group_id    TEXT        NOT NULL CHECK (group_id IN ('files')),
    mode        TEXT        NOT NULL CHECK (mode IN ('read', 'write')),
    ok          BOOLEAN     NOT NULL,
    reason      TEXT        NOT NULL CHECK (reason IN
                    ('ok', 'dependency_failure', 'circuit_open', 'not_configured')),
    observed_at TIMESTAMPTZ NOT NULL,
    valid_until TIMESTAMPTZ NOT NULL,
    stopped     BOOLEAN     NOT NULL DEFAULT false,
    PRIMARY KEY (instance, group_id, mode)
);

COMMENT ON TABLE availability.observations IS
    'Наблюдения доступности групп функций по экземплярам (4.11, M161): свежесть — valid_until.';

CREATE TABLE availability.restrictions (
    group_id    TEXT        PRIMARY KEY CHECK (group_id IN ('files')),
    mode        TEXT        NOT NULL CHECK (mode IN ('read_only', 'unavailable')),
    reason_code TEXT        NOT NULL CHECK (reason_code IN
                    ('maintenance', 'incident', 'security', 'other')),
    note        TEXT        NOT NULL CHECK (length(note) BETWEEN 3 AND 500),
    set_by      UUID        NOT NULL REFERENCES identity.users(id),
    set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE availability.restrictions IS
    'Ручные ограничения групп функций (4.11, M161): отдельно от продуктовых флагов; '
    'автоматическое восстановление их не снимает.';

ALTER TABLE availability.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability.observations FORCE ROW LEVEL SECURITY;
ALTER TABLE availability.restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability.restrictions FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA availability TO app_backend, app_readonly;
GRANT SELECT, INSERT, UPDATE ON availability.observations TO app_backend;
GRANT SELECT ON availability.observations, availability.restrictions TO app_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON availability.restrictions TO app_backend;

-- Наблюдения пишет и читает само ядро (служебная задача) — содержимое без данных людей.
CREATE POLICY observations_core ON availability.observations
    FOR ALL TO app_backend USING (true) WITH CHECK (true);
CREATE POLICY observations_read ON availability.observations
    FOR SELECT TO app_readonly USING (true);

-- Действующее ограничение нужно каждой проверке операции; менять — только с полномочием.
CREATE POLICY restrictions_read ON availability.restrictions
    FOR SELECT TO app_backend USING (true);
CREATE POLICY restrictions_read_ops ON availability.restrictions
    FOR SELECT TO app_readonly USING (true);
CREATE POLICY restrictions_insert ON availability.restrictions
    FOR INSERT TO app_backend WITH CHECK (app.has_capability('ops.availability.update'));
CREATE POLICY restrictions_update ON availability.restrictions
    FOR UPDATE TO app_backend USING (app.has_capability('ops.availability.update'))
    WITH CHECK (app.has_capability('ops.availability.update'));
CREATE POLICY restrictions_delete ON availability.restrictions
    FOR DELETE TO app_backend USING (app.has_capability('ops.availability.update'));

INSERT INTO identity.staff_capabilities
    (code, section, action, title, description, requires_assignment, sort_order) VALUES
    ('ops.availability.update', 'Эксплуатация', 'update',
     'Ограничивать группы функций',
     'Вводить и снимать ручное ограничение группы функций (например, «Файлы»: только чтение '
     'или недоступна). Автоматическое восстановление сервиса такое ограничение не снимает. '
     'Каждое изменение попадает в журнал.',
     false, 10)
ON CONFLICT (code) DO NOTHING;

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('ops.function_restriction.set', 'Введено или изменено ручное ограничение группы функций',
     ARRAY['admin']),
    ('ops.function_restriction.cleared', 'Снято ручное ограничение группы функций',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
