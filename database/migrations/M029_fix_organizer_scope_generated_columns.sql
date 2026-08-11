-- =============================================================================
-- M029 — исправление границы прав организатора: генерируемые колонки
--
-- Находка живого прогона: перевод проекта по этапам падал у ЛЮБОГО организатора
-- отказом «organizer may change project stage only», хотя менялся ровно статус.
--
-- Причина: сравнение «всё, кроме статуса и отметки времени, должно совпасть»
-- выполнялось по `to_jsonb(NEW)`, а у `lab.projects` есть генерируемая колонка
-- (`public_search_tsv`). В BEFORE-триггере генерируемые колонки ещё не
-- вычислены — в NEW они NULL, тогда как в OLD лежит прежнее значение. Разница
-- была не в данных, а в моменте: строки сравнивались на разных стадиях жизни.
--
-- Исправление: из сравнения исключаются генерируемые колонки — список берётся
-- из системного каталога, а не перечисляется вручную, иначе следующая такая
-- колонка воспроизведёт ту же ошибку. Смысл проверки не меняется: организатор
-- по-прежнему может изменить только этап.
--
-- Урок общий: проверка «строка не изменилась», написанная через сравнение всей
-- строки в BEFORE-триггере, ложно срабатывает на всём, что БД вычисляет позже.
-- =============================================================================

CREATE OR REPLACE FUNCTION lab.limit_organizer_project_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, app, public
AS $$
DECLARE
    v_skip TEXT[];
BEGIN
    -- Админ и участники проекта сюда не относятся: у них своя, более широкая
    -- политика, и это правило их не касается.
    IF app.has_role('admin') OR lab.is_project_member(OLD.id, app.current_user_id()) THEN
        RETURN NEW;
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        SELECT ARRAY['status', 'updated_at'] || coalesce(array_agg(a.attname), ARRAY[]::TEXT[])
          INTO v_skip
          FROM pg_attribute a
         WHERE a.attrelid = 'lab.projects'::regclass
           AND a.attnum > 0
           AND NOT a.attisdropped
           -- Генерируемые колонки вычисляются ПОСЛЕ before-триггеров: в NEW
           -- они пусты, и сравнивать их со значением в OLD бессмысленно.
           AND a.attgenerated <> '';

        IF (to_jsonb(NEW) - v_skip) IS DISTINCT FROM (to_jsonb(OLD) - v_skip) THEN
            RAISE EXCEPTION 'organizer may change project stage only'
                USING ERRCODE = '42501';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'organizer may change project stage only' USING ERRCODE = '42501';
END $$;

COMMENT ON FUNCTION lab.limit_organizer_project_update() IS
    'Организатор меняет у чужого проекта только этап. Генерируемые колонки '
    'исключены из сравнения: в before-триггере они ещё не вычислены.';
