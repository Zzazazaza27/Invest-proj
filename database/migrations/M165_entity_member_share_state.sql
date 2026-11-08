-- M165 — повтор добавления участника юрлица (блок 2, 2.6; пакет 8 раздела 01, 09.11.2026).
--
-- Владелец юрлица добавляет участников (политика entity_members_insert), но читает из
-- состава только свои строки (entity_members_select), а менять долю может только
-- администратор (entity_members_update). Поэтому `INSERT … ON CONFLICT DO UPDATE` у
-- владельца падал на проверке чтения для вставляемой чужой строки (42501), а сравнить долю
-- при повторе он не мог.
--
-- Функция отвечает ровно на вопрос повтора — «участник есть и доля та же?» — и только
-- владельцу юрлица или администратору; другим — NULL. Состав целиком она не раскрывает.

CREATE OR REPLACE FUNCTION kyc.member_share_state(
    p_entity UUID,
    p_user UUID,
    p_role TEXT,
    p_share NUMERIC
) RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, kyc, app, pg_temp
AS $$
    SELECT CASE
        WHEN NOT (app.has_role('admin') OR EXISTS (
                SELECT 1 FROM kyc.business_entities e
                 WHERE e.id = p_entity AND e.owner_user_id = app.current_user_id()
                   AND e.deleted_at IS NULL))
            THEN NULL
        WHEN m.entity_id IS NULL THEN 'absent'
        WHEN m.share_pct IS NOT DISTINCT FROM p_share THEN 'same'
        ELSE 'different'
    END
      FROM (SELECT 1) AS one
      LEFT JOIN kyc.entity_members m
        ON m.entity_id = p_entity AND m.user_id = p_user AND m.member_role = p_role
$$;

COMMENT ON FUNCTION kyc.member_share_state(UUID, UUID, TEXT, NUMERIC) IS
    'Повтор добавления участника (2.6, M165): absent / same / different — владельцу юрлица '
    'или администратору; другим NULL.';

REVOKE ALL ON FUNCTION kyc.member_share_state(UUID, UUID, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kyc.member_share_state(UUID, UUID, TEXT, NUMERIC) TO app_backend;
