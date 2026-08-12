-- =============================================================================
-- M040 — ссылка на продукт считается загруженной в момент создания
--
-- Дефект, найденный ЖИВЫМ ПРОГОНОМ (smoke-techdebt: «рецензент видит материалы
-- назначенного проекта — материалов 0»).
--
-- M037 разделил намерение и факт: материал показывается наружу только с
-- отметкой `uploaded_at`. Существующие ссылки на продукт та миграция пометила
-- загруженными — «ссылки загрузки не требуют». Но правило осталось разовым
-- действием, а не инвариантом: КАЖДАЯ НОВАЯ ссылка создавалась без отметки и
-- потому не показывалась ни владельцу, ни рецензенту. Добавление ссылки через
-- API возвращало 201 и не делало ничего видимого.
--
-- Здесь правило становится свойством данных. Триггер, а не CHECK: у ссылки
-- нечего ждать — момент создания И ЕСТЬ момент загрузки, поэтому правильное
-- поведение не «отвергнуть вставку без отметки», а проставить её.
-- =============================================================================

CREATE OR REPLACE FUNCTION lab.mark_product_link_uploaded()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    IF NEW.type = 'product_link' AND NEW.uploaded_at IS NULL THEN
        NEW.uploaded_at := coalesce(NEW.created_at, now());
    END IF;
    RETURN NEW;
END $$;

COMMENT ON FUNCTION lab.mark_product_link_uploaded() IS
    'Ссылка на продукт не проходит через хранилище: момент её создания и есть '
    'момент загрузки. Без этого новая ссылка не показывалась наружу (M040).';

DROP TRIGGER IF EXISTS project_materials_product_link_uploaded ON lab.project_materials;
CREATE TRIGGER project_materials_product_link_uploaded
    BEFORE INSERT ON lab.project_materials
    FOR EACH ROW EXECUTE FUNCTION lab.mark_product_link_uploaded();

-- Ссылки, созданные между M037 и этой миграцией, невидимы наружу. Данные у них
-- целые — не хватает только отметки.
UPDATE lab.project_materials
   SET uploaded_at = created_at
 WHERE type = 'product_link' AND uploaded_at IS NULL;
