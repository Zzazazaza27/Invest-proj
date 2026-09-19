-- M118 — оплаченная услуга навсегда ссылается на СВОЙ отчёт (этап 6.2).
--
-- Пересчёт анализа создаёт НОВУЮ версию паспорта и помечает прежнюю
-- `superseded_at` — так было с самого начала. Но у прогона оплаченной услуги
-- ссылка на результат менялась свободно, и «пересчитать» однажды означало бы
-- «подменить отчёт, за который заплатили».
--
-- Разница принципиальна. Основатель купил разбор своей версии заявки. Новый
-- разбор — это новый результат, а не исправленный старый: он может опираться
-- на другие данные, другую модель и другой промпт. Подменять им прежний отчёт
-- нельзя даже тогда, когда новый «лучше».

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

    -- Результат оплаченной услуги — конкретный отчёт, а не «последний».
    IF OLD.result_ref IS NOT NULL AND NEW.result_ref IS DISTINCT FROM OLD.result_ref THEN
        RAISE EXCEPTION
            'результат оплаченной услуги не подменяется: пересчёт создаёт новый отчёт'
            USING ERRCODE = '42501';
    END IF;
    IF OLD.input_sha256 IS NOT NULL AND NEW.input_sha256 IS DISTINCT FROM OLD.input_sha256 THEN
        RAISE EXCEPTION 'отпечаток входа прогона неизменяем' USING ERRCODE = '42501';
    END IF;
    IF OLD.input_version_id IS NOT NULL
       AND NEW.input_version_id IS DISTINCT FROM OLD.input_version_id THEN
        RAISE EXCEPTION 'версия заявки у прогона неизменяема' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION billing.guard_item_run_transition() IS
    'Прогон услуги неизменяем в существенном (M111, дополнено M118): завершённый не '
    'переигрывается, результат не подменяется, отпечаток и версия входа не переписываются. '
    'Пересчёт анализа создаёт новую версию паспорта и прежний отчёт не трогает.';
