-- M117 — в паспорте хранится не только ОТКУДА взято поле, но и ЧТО было взято.
--
-- M116 записал источник каждого поля входа: version — из неизменяемого
-- снимка, card — из текущей карточки или справочника. Этого мало.
--
-- Отрасль живёт в справочнике `lab.project_taxonomy`, и её название меняют:
-- «Финтех» становится «Финансовые технологии». Паспорт, сделанный полгода
-- назад, после этого начинал бы объяснять себя новым словом — хотя
-- анализировалось старое. Метка `card` про это ничего не говорит: она
-- сообщает, что значение бралось снаружи снимка, но не какое именно.
--
-- Поэтому фактически использованные значения фиксируются в самом паспорте.
-- Объяснение старого отчёта перестаёт зависеть от того, что сегодня лежит в
-- справочнике и в карточке проекта.

ALTER TABLE scoring.investment_passports
    ADD COLUMN IF NOT EXISTS input_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN scoring.investment_passports.input_metadata IS
    'Фактически использованные значения полей входа (M117): сумма запроса, валюта, отрасль, '
    'страна, тип бизнеса, предмет привлечения, use of funds, runway. Вместе с input_sources '
    'даёт полное объяснение отчёта, не зависящее от сегодняшнего состояния справочников.';

/**
 * Использованные значения не переписываются.
 *
 * Тот же довод, что у отпечатка: новый разбор создаёт новую версию паспорта.
 * Менять вход уже опубликованной версии нечем, кроме ошибки.
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
    IF OLD.input_metadata <> '{}'::jsonb AND NEW.input_metadata IS DISTINCT FROM OLD.input_metadata
    THEN
        RAISE EXCEPTION 'использованные значения входа неизменяемы'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;
