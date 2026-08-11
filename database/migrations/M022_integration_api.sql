-- =============================================================================
-- M022 — опоры Integration API
--
-- Роль `app_integration` намеренно НЕ имеет доступа к схеме `identity`: там
-- живут персональные данные, а интеграционный контур отдаёт наружу только
-- обезличенные проекции. Но обезличенная проекция для медиаконтура выдаётся
-- лишь при ДЕЙСТВУЮЩЕМ согласии на публичность — а согласие лежит как раз в
-- `identity`.
--
-- Выдавать роли USAGE на схему ради одного факта нельзя: это открыло бы ей
-- дорогу ко всему остальному. Решение то же, что в M012 для входа, — узкая
-- SECURITY DEFINER-функция, которая возвращает РОВНО факт согласия: его scope
-- и момент выдачи. Ни идентификатора пользователя, ни его данных через неё не
-- достать.
--
-- Функция живёт в схеме `integration`, а не `identity`, и это не вкусовщина:
-- вызвать функцию нельзя без USAGE на её схему — SECURITY DEFINER этого не
-- отменяет (проверено прогоном: `permission denied for schema identity`).
-- Разместив обёртку в схеме, к которой у роли USAGE уже есть, мы не открываем
-- ей видимость схемы с персональными данными вообще.
-- =============================================================================

CREATE OR REPLACE FUNCTION integration.active_publication_consent(
    p_project_id UUID,
    p_scope      TEXT
) RETURNS TABLE (scope TEXT, granted_at TIMESTAMPTZ)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, identity, public
AS $$
    SELECT pc.scope, pc.accepted_at
      FROM identity.publication_consents pc
     WHERE pc.project_id = p_project_id
       AND pc.scope = p_scope
       AND pc.revoked_at IS NULL
     ORDER BY pc.accepted_at ASC
     LIMIT 1;
$$;

COMMENT ON FUNCTION integration.active_publication_consent(UUID, TEXT) IS
    'Факт действующего согласия на публичность проекта: только scope и момент '
    'выдачи. Существует, чтобы интеграционная роль не получала доступ к схеме '
    'identity целиком. Отзыв согласия немедленно делает результат пустым.';

REVOKE ALL ON FUNCTION integration.active_publication_consent(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION integration.active_publication_consent(UUID, TEXT)
    TO app_integration, app_backend;

-- --------------------------------------------------- реестр типов событий
-- Значимые действия интеграционного контура — доменные факты и пишутся в
-- журнал. Поток ЧТЕНИЙ через Integration API туда не пишется: append-only
-- журнал с hash-chain — это запись о том, что изменилось, а не access log.
-- Чтения уходят в структурированный лог приложения с client_id и trace_id.
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('integration.service_account.created', 'Создан сервисный аккаунт интеграции', ARRAY['admin']),
    ('integration.service_account.rotated', 'Ротирован секрет сервисного аккаунта', ARRAY['admin']),
    ('integration.token.issued',            'Выдан токен сервисному клиенту',       ARRAY['system']),
    ('integration.listing.created',         'Внешний листинг выпускника зарегистрирован', ARRAY['system']),
    ('integration.webhook.registered',      'Внешняя система подписалась на события', ARRAY['system'])
ON CONFLICT (verb) DO NOTHING;

-- ------------------------------------------------- момент выпуска проекта
-- Внешней системе нужен не только список выпускников, но и когда каждый из них
-- выпущен: по этому моменту Capital решает, что нового появилось с прошлой
-- синхронизации. Выводить его из `updated_at` нельзя — тот меняется при любой
-- правке проекта, и курсор пагинации поехал бы под ногами у потребителя.
--
-- Момент проставляет ТРИГГЕР, а не сервис: факт выпуска обязан фиксироваться
-- независимо от того, каким путём кода статус переведён, и не переписываться
-- при повторных обновлениях строки.
ALTER TABLE lab.projects ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ;

COMMENT ON COLUMN lab.projects.graduated_at IS
    'Момент перехода в статус graduated. Ставится триггером один раз и не '
    'переписывается: это точка отсчёта синхронизации для внешних систем.';

CREATE OR REPLACE FUNCTION lab.stamp_graduated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, lab, public
AS $$
BEGIN
    IF NEW.status = 'graduated' AND NEW.graduated_at IS NULL THEN
        NEW.graduated_at := now();
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS projects_stamp_graduated_at ON lab.projects;
CREATE TRIGGER projects_stamp_graduated_at
    BEFORE INSERT OR UPDATE OF status ON lab.projects
    FOR EACH ROW EXECUTE FUNCTION lab.stamp_graduated_at();

-- Backfill уже выпущенных: момент берётся из append-only журнала, а при его
-- отсутствии — из updated_at. Приблизительное значение честнее пустоты, но
-- источник указан в комментарии к колонке, а не выдаётся за точный.
UPDATE lab.projects p
   SET graduated_at = COALESCE(
       (SELECT min(e.ts) FROM audit.events e
         WHERE e.verb = 'lab.project.graduated' AND e.subject_id = p.id),
       p.updated_at)
 WHERE p.status = 'graduated' AND p.graduated_at IS NULL;

-- ----------------------------------------------------- индекс под выборку
-- Выпускники отдаются страницами с keyset-курсором по (graduated_at, id).
-- Без индекса это sequential scan по всей таблице проектов на каждый вызов
-- внешней системы.
CREATE INDEX IF NOT EXISTS projects_graduated_keyset
    ON lab.projects (graduated_at DESC, id DESC)
    WHERE status = 'graduated' AND deleted_at IS NULL;
