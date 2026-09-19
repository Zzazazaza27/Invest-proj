-- M116 — происхождение в самом паспорте.
--
-- До сих пор «по какой версии и каким данным сделан отчёт» знал только прогон
-- услуги (`billing.purchase_item_runs`). Паспорт, созданный прямым вызовом
-- анализа, происхождения не нёс вовсе: по записи нельзя было ответить, что
-- именно анализировалось.
--
-- Это не бухгалтерия ради бухгалтерии. Паспорт показывают инвестору, и вопрос
-- «отчёт о какой версии заявки я читаю» — первый, который он задаст. Ответ
-- обязан быть в самом паспорте, а не в соседней таблице, к которой у него нет
-- доступа.

ALTER TABLE scoring.investment_passports
    ADD COLUMN IF NOT EXISTS project_version_id UUID REFERENCES lab.project_versions(id);
ALTER TABLE scoring.investment_passports
    ADD COLUMN IF NOT EXISTS input_sha256 TEXT
    CHECK (input_sha256 IS NULL OR input_sha256 ~ '^[0-9a-f]{64}$');
/**
 * Источник каждого поля входа: version | card | round | absent.
 *
 * Нужен потому, что часть входа берётся не из снимка: название отрасли живёт
 * в справочнике, а не в версии. Без этой записи «отчёт по версии N» тихо
 * включал бы в себя сегодняшнюю правку карточки.
 */
ALTER TABLE scoring.investment_passports
    ADD COLUMN IF NOT EXISTS input_sources JSONB NOT NULL DEFAULT '{}'::jsonb;
/**
 * Участвовали ли ответы анкеты.
 *
 * false — разобрана карточка проекта. Такой паспорт нельзя называть анализом
 * версии заявки, и интерфейс обязан говорить это прямо.
 */
ALTER TABLE scoring.investment_passports
    ADD COLUMN IF NOT EXISTS includes_answers BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN scoring.investment_passports.project_version_id IS
    'Версия заявки, по ответам которой сделан отчёт (M116). NULL — ответы не участвовали.';
COMMENT ON COLUMN scoring.investment_passports.input_sha256 IS
    'Отпечаток фактически проанализированного входа (M116): ответы, метаданные, версия.';
COMMENT ON COLUMN scoring.investment_passports.input_sources IS
    'Откуда взято каждое поле входа (M116): version — из неизменяемого снимка, card — из текущей '
    'карточки проекта, absent — источника нет и значение пустое.';

CREATE INDEX investment_passports_version
    ON scoring.investment_passports (project_version_id)
    WHERE project_version_id IS NOT NULL;

/**
 * Происхождение не переписывается.
 *
 * Паспорт версионируется: новый анализ создаёт НОВУЮ версию и помечает
 * прежнюю `superseded_at`. Значит, у каждой версии своё происхождение, и
 * менять его задним числом нечем — кроме ошибки.
 */
CREATE OR REPLACE FUNCTION scoring.forbid_passport_provenance_rewrite()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, scoring, pg_temp
AS $$
BEGIN
    IF OLD.input_sha256 IS NOT NULL AND NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256 THEN
        RAISE EXCEPTION 'отпечаток входа паспорта неизменяем: новый разбор создаёт новую версию'
            USING ERRCODE = '42501';
    END IF;
    IF OLD.project_version_id IS NOT NULL
       AND NEW.project_version_id IS DISTINCT FROM OLD.project_version_id THEN
        RAISE EXCEPTION 'версия заявки у паспорта неизменяема'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER investment_passports_provenance_guard
    BEFORE UPDATE ON scoring.investment_passports
    FOR EACH ROW EXECUTE FUNCTION scoring.forbid_passport_provenance_rewrite();
