-- =============================================================================
-- M174 — текущее право автора перед публикацией загрузки (блок 10, вопрос 3; Тэнк 09.11).
--
-- Загрузка, начатая по проверенному запросу, публикуется позже — браузером или фоновой
-- сверкой, иногда через часы. Перед публикацией проверяется, что у автора загрузки
-- ВСЁ ЕЩЁ есть право менять проект: участник проекта или действующий администратор, и
-- учётная запись активна. Нет права — материал отклоняется («право отозвано»).
-- Уже опубликованное задним числом не отменяется. Недоступность проверки — не отказ:
-- ошибка запроса оставляет загрузку «ожидает» до следующей попытки.
--
-- migrate:compat-none: новая функция; прежнее ядро её не вызывает.
-- =============================================================================
CREATE FUNCTION lab.uploader_may_publish(p_project_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, lab, identity, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM identity.users u
         WHERE u.id = p_user_id AND u.status = 'active' AND u.deleted_at IS NULL
    )
    AND (
        lab.is_project_member(p_project_id, p_user_id)
        OR EXISTS (
            SELECT 1 FROM identity.user_roles r
             WHERE r.user_id = p_user_id AND r.role = 'admin' AND r.revoked_at IS NULL
        )
    );
$$;
COMMENT ON FUNCTION lab.uploader_may_publish(UUID, UUID) IS
    'Право автора загрузки на проект в момент публикации (M174): участник или действующий '
    'администратор, учётная запись активна. Только ответ да/нет.';
REVOKE ALL ON FUNCTION lab.uploader_may_publish(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lab.uploader_may_publish(UUID, UUID) TO app_maintenance;
