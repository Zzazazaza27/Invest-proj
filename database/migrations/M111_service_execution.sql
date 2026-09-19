-- M111 — исполнение услуги по позиции покупки (этап 6.1).
--
-- До сих пор «услуга выполнена» означало ровно одно: сотрудник поставил
-- отметку с основанием. Для услуг, которые выполняет ЧЕЛОВЕК (сверка
-- реквизитов, проверка комплектности), это правильно и остаётся.
--
-- Для ИИ-разбора так нельзя. Отметка «выполнено» на услуге, которую обязана
-- выполнить платформа, — это продажа несделанной работы: основатель заплатил
-- за отчёт, а получил галочку. Поэтому у услуги появляется СПОСОБ ИСПОЛНЕНИЯ,
-- а у позиции покупки — запись о фактическом прогоне.
--
-- Правила, которые здесь закреплены:
--
--   • услугу, исполняемую платформой, нельзя отметить выполненной руками —
--     только успешный прогон с сохранённым результатом;
--   • прогон фиксирует ВЕРСИЮ входа: по какой версии заявки и каким
--     материалам сделан отчёт. Правка заявки после разбора старый отчёт
--     актуальным не делает — она делает его отчётом о прошлой версии;
--   • повторный запрос не создаёт второе исполнение;
--   • состояние прогона движется вперёд: незавершённый прогон не
--     «перезапускается» тихо поверх идущего.
--
-- Чего здесь НЕТ намеренно: никакого нового пути выдачи отчёта инвестору.
-- Раскрытие идёт существующими правилами видимости и уровнем раскрытия
-- паспорта. ИИ-отчёт не означает ни одобрения проекта, ни допуска раунда.

-- ============================================ способ исполнения услуги
ALTER TABLE billing.round_services
    ADD COLUMN IF NOT EXISTS execution_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (execution_kind IN ('manual', 'ai_analysis'));
COMMENT ON COLUMN billing.round_services.execution_kind IS
    'Кто выполняет услугу (M111): manual — сотрудник ставит отметку с основанием; ai_analysis — '
    'платформа, и отметка появляется только после успешного прогона с сохранённым результатом.';

-- ====================================== прогон услуги по позиции покупки
CREATE TABLE billing.purchase_item_runs (
    id            UUID PRIMARY KEY,
    item_id       UUID NOT NULL REFERENCES billing.round_purchase_items(id),
    purchase_id   UUID NOT NULL REFERENCES billing.round_purchases(id),
    project_id    UUID NOT NULL REFERENCES lab.projects(id),
    kind          TEXT NOT NULL CHECK (kind IN ('ai_analysis')),
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    /**
     * Прогон выполнен ТЕСТОВЫМ способом, а не настоящим разбором.
     *
     * Метка нужна там же, где метка тестовой оплаты: чтобы потом отличить
     * проверку сценария от оказанной услуги. Снять её нельзя.
     */
    is_test       BOOLEAN NOT NULL DEFAULT false,

    -- --------------------------------------------------------- версия входа
    -- К чему относится отчёт. Без этого «отчёт от 19-го» нечем связать с тем,
    -- что в заявке было на тот момент.
    input_version_id UUID REFERENCES lab.project_versions(id),
    input_sha256     TEXT CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$'),
    input_snapshot   JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- ------------------------------------------------------------ результат
    agent_run_id  UUID REFERENCES audit.agent_runs(id),
    result_ref    UUID,
    result_kind   TEXT CHECK (result_kind IS NULL OR result_kind IN ('passport')),
    /** Чем именно выполнено: llm | heuristic | test. Пишется словом, не флагом. */
    engine        TEXT CHECK (engine IS NULL OR engine IN ('llm', 'heuristic', 'test')),

    error_code    TEXT,
    error_message TEXT CHECK (error_message IS NULL OR length(error_message) <= 1000),

    requested_by  UUID REFERENCES identity.users(id),
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,

    CHECK (finished_at IS NULL OR finished_at >= started_at),
    CHECK (status <> 'succeeded' OR (result_ref IS NOT NULL AND input_sha256 IS NOT NULL)),
    CHECK (status <> 'failed' OR error_message IS NOT NULL)
);
CREATE INDEX purchase_item_runs_item ON billing.purchase_item_runs (item_id, started_at DESC);
CREATE INDEX purchase_item_runs_purchase ON billing.purchase_item_runs (purchase_id);

COMMENT ON TABLE billing.purchase_item_runs IS
    'Фактическое исполнение услуги по позиции покупки (M111). Успешный прогон обязан нести '
    'результат и отпечаток входа: «выполнено» без сохранённого результата не бывает.';

/**
 * Одно исполнение на позицию.
 *
 * Идущий прогон не даёт запустить второй — повторное нажатие возвращает
 * текущий. Успешный прогон закрывает вопрос совсем: повтор не переделывает
 * уже оплаченную и оказанную услугу.
 */
CREATE UNIQUE INDEX purchase_item_runs_active
    ON billing.purchase_item_runs (item_id)
    WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX purchase_item_runs_done
    ON billing.purchase_item_runs (item_id)
    WHERE status = 'succeeded';

/** Состояние прогона движется вперёд; метка тестового исполнения не снимается. */
CREATE OR REPLACE FUNCTION billing.guard_item_run_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'прогон услуги не удаляется: это след оказанной работы'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.item_id <> OLD.item_id OR NEW.purchase_id <> OLD.purchase_id THEN
        RAISE EXCEPTION 'прогон не переносится на другую позицию' USING ERRCODE = '42501';
    END IF;
    IF OLD.is_test AND NOT NEW.is_test THEN
        RAISE EXCEPTION 'метку тестового исполнения снять нельзя' USING ERRCODE = '42501';
    END IF;
    IF OLD.status IN ('succeeded', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'завершённый прогон не переигрывается: запускайте новый'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER purchase_item_runs_guard
    BEFORE UPDATE OR DELETE ON billing.purchase_item_runs
    FOR EACH ROW EXECUTE FUNCTION billing.guard_item_run_transition();

/**
 * Услугу платформы нельзя отметить выполненной руками.
 *
 * Это и есть запрет подменять исполнение статусом. Отметка появляется только
 * тогда, когда по позиции есть успешный прогон с сохранённым результатом.
 * Для услуг, которые выполняет человек, всё остаётся как было.
 */
CREATE OR REPLACE FUNCTION billing.guard_item_fulfillment_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, billing, pg_temp
AS $$
DECLARE
    v_kind TEXT;
BEGIN
    IF NEW.fulfillment_status <> 'fulfilled' THEN
        RETURN NEW;
    END IF;
    IF NEW.service_code IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.execution_kind INTO v_kind
      FROM billing.round_services s
     WHERE s.code = NEW.service_code;

    IF v_kind IS NULL OR v_kind = 'manual' THEN
        RETURN NEW;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM billing.purchase_item_runs r
         WHERE r.item_id = NEW.id AND r.status = 'succeeded' AND r.result_ref IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'услуга «%» выполняется платформой: отметка появится после успешного разбора',
            NEW.service_code
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER round_purchase_items_fulfillment_source
    BEFORE UPDATE ON billing.round_purchase_items
    FOR EACH ROW EXECUTE FUNCTION billing.guard_item_fulfillment_source();

-- ------------------------------------------------------------------ RLS
ALTER TABLE billing.purchase_item_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.purchase_item_runs FORCE  ROW LEVEL SECURITY;

-- Прогон видит команда проекта (это её оплаченная услуга) и администратор.
-- Отдельного доступа инвестору здесь нет: отчёт раскрывается существующими
-- правилами видимости, а не этой таблицей.
CREATE POLICY purchase_item_runs_team ON billing.purchase_item_runs FOR SELECT
    TO app_backend USING (
        app.has_role('admin')
        OR lab.is_project_member(project_id, app.current_user_id()));
CREATE POLICY purchase_item_runs_write ON billing.purchase_item_runs FOR ALL
    TO app_backend USING (
        app.has_role('admin')
        OR lab.is_project_member(project_id, app.current_user_id()))
    WITH CHECK (
        app.has_role('admin')
        OR lab.is_project_member(project_id, app.current_user_id()));

GRANT SELECT, INSERT, UPDATE ON billing.purchase_item_runs TO app_backend;

-- --------------------------------------------------------- глаголы аудита
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('billing.service_run.started',
     'Запущено исполнение услуги по позиции покупки',
     ARRAY['founder', 'admin']),
    ('billing.service_run.finished',
     'Исполнение услуги завершено',
     ARRAY['founder', 'admin', 'system'])
ON CONFLICT (verb) DO NOTHING;
