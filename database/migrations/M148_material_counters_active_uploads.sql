-- M148 — квота материалов считает только готовые и активные загрузки (2.1-W03).
--
-- Почему. Квота «50 материалов, из них 5 незавершённых» (M057) держалась на
-- прежнем уборщике: брошенная загрузка удалялась через сутки и освобождала
-- место. С M147 удаления по возрасту нет (2.1.2: брошенные загрузки не
-- очищаются до согласования правил) — без этой правки пять брошенных форм
-- навсегда закрыли бы проекту загрузку.
--
-- Что считается:
--  * готовые материалы;
--  * активные загрузки — «ожидает», и при этом форма ещё действует либо
--    хранилище уже подтвердило получение объекта (его обработка идёт).
-- Не считаются: «отклонено», «требует вмешательства» и «ожидает» с истёкшей
-- формой без полученного объекта. Записи остаются в БД; если объект всё же
-- появится, сверка его завершит, и материал станет готовым.

CREATE OR REPLACE FUNCTION lab.material_counters(p_project_id UUID)
RETURNS TABLE (total BIGINT, pending BIGINT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, lab, pg_temp
AS $$
    WITH counted AS (
        SELECT m.upload_state = 'ready' AS ready,
               m.upload_state = 'pending'
               AND (m.object_received_at IS NOT NULL
                    OR (m.upload_expires_at IS NOT NULL AND m.upload_expires_at > now()))
                   AS active
          FROM lab.project_materials m
         WHERE m.project_id = p_project_id
    )
    SELECT count(*) FILTER (WHERE ready OR active)::bigint,
           count(*) FILTER (WHERE active)::bigint
      FROM counted;
$$;

COMMENT ON FUNCTION lab.material_counters(UUID) IS
    'Числа для квоты загрузок поверх RLS: готовые материалы и активные загрузки '
    '(форма действует или объект получен). Брошенные и отклонённые не считаются (M148).';
