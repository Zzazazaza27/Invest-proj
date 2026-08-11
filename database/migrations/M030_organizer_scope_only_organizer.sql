-- =============================================================================
-- M030 — правило границы организатора применяется ТОЛЬКО к организатору
--
-- Находка живого замера: подготовка синтетических данных упала на обычном
-- `UPDATE lab.projects SET listing_status = 'listed'`, выполненном владельцем
-- БД. Причина — в M025/M029 триггер был написан как «запретить всё, кроме
-- смены этапа», и под это правило попадал КАЖДЫЙ, кто не админ и не участник
-- проекта: обслуживающие процедуры, сервисные роли, миграции.
--
-- Правило задумывалось узким: «организатор дотягивается до чужого проекта
-- только ради этапа». Таким оно и должно быть — сначала проверяется, что перед
-- нами именно организатор, и лишь затем ограничивается его действие. Все
-- прочие пути по-прежнему ограничены своими RLS-политиками: триггер их не
-- заменяет и не должен.
--
-- Урок общий: триггер, сформулированный как «запретить всем, кроме случая X»,
-- действует на всех писателей таблицы, включая те пути, о которых автор
-- правила не думал. Формулировка «ограничить именно роль X» такого побочного
-- действия не имеет.
-- =============================================================================

CREATE OR REPLACE FUNCTION lab.limit_organizer_project_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, app, public
AS $$
DECLARE
    v_skip TEXT[];
BEGIN
    -- Правило адресное: оно про организатора и ни про кого больше.
    IF NOT app.has_role('organizer') THEN
        RETURN NEW;
    END IF;
    -- Организатор, который вдобавок админ или участник проекта, действует по
    -- своим более широким правам — сужать их этим правилом незачем.
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
           -- Генерируемые колонки в before-триггере ещё не вычислены (M029).
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
    'Сужает права ИМЕННО организатора: у чужого проекта он меняет только этап. '
    'На прочих писателей таблицы правило не распространяется — их ограничивают '
    'собственные политики.';
