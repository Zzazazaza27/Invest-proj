-- =============================================================================
-- M013 — барьеры комплаенса и события фазы Ф4
--
-- Что здесь: (1) регистрация verb'ов, которые начинает писать core в фазе
-- проектов и верификаций, (2) запрет самоодобрения верификаций на уровне БД.
--
-- Почему запрет живёт в БД, а не только в сервисе: политика kyc_decide_admin
-- разрешает роли admin обновлять ЛЮБУЮ строку верификации, включая собственную.
-- Администратор — тоже пользователь платформы, и он может подать заявку на
-- верификацию сам. Сервисная проверка закрывает штатный путь, но не закрывает
-- ошибку в будущем коде и не закрывает прямой доступ к БД под app_backend.
-- =============================================================================

-- ------------------------------------------------------- реестр типов событий
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('kyc.verification.submitted', 'Заявка на верификацию подана',
     ARRAY['founder','investor','expert','organizer','admin','system']),
    ('kyc.entity.created',         'Юридическое лицо заведено',
     ARRAY['founder','investor','admin','system']),
    ('kyc.entity.member_added',    'Участник юрлица добавлен',
     ARRAY['founder','investor','admin','system']),
    ('kyc.kyb.submitted',          'Заявка на проверку юрлица подана',
     ARRAY['founder','investor','admin','system']),
    ('kyc.kyb.decided',            'Решение по проверке юрлица',
     ARRAY['admin','system']),
    ('lab.project.created',        'Заявка проекта создана',
     ARRAY['founder','system']),
    ('lab.project.updated',        'Карточка проекта изменена',
     ARRAY['founder','admin','system']),
    ('lab.material.added',         'Материал проекта добавлен',
     ARRAY['founder','system'])
ON CONFLICT (verb) DO NOTHING;

-- --------------------------------------------- запрет самоодобрения (KYC)
CREATE OR REPLACE FUNCTION kyc.forbid_self_review()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, kyc, public
AS $$
BEGIN
    IF NEW.status NOT IN ('approved','rejected') THEN
        RETURN NEW;
    END IF;
    IF NEW.reviewed_by IS NULL THEN
        RAISE EXCEPTION 'решение по верификации требует указания проверяющего'
            USING ERRCODE = '23514';
    END IF;
    IF NEW.reviewed_by = NEW.user_id THEN
        RAISE EXCEPTION 'самоодобрение верификации запрещено'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER kyc_verifications_no_self_review
    BEFORE INSERT OR UPDATE ON kyc.kyc_verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.forbid_self_review();

-- --------------------------------------------- запрет самоодобрения (KYB)
-- Для юрлица «сам себя» шире, чем равенство идентификаторов: проверяющий не
-- должен быть ни владельцем юрлица, ни его участником.
CREATE OR REPLACE FUNCTION kyc.forbid_self_review_kyb()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, kyc, public
AS $$
DECLARE
    v_conflict BOOLEAN;
BEGIN
    IF NEW.status NOT IN ('approved','rejected') THEN
        RETURN NEW;
    END IF;
    IF NEW.reviewed_by IS NULL THEN
        RAISE EXCEPTION 'решение по проверке юрлица требует указания проверяющего'
            USING ERRCODE = '23514';
    END IF;
    SELECT EXISTS (
        SELECT 1 FROM kyc.business_entities e
        WHERE e.id = NEW.entity_id AND e.owner_user_id = NEW.reviewed_by
    ) OR kyc.is_entity_member(NEW.entity_id, NEW.reviewed_by)
    INTO v_conflict;

    IF v_conflict THEN
        RAISE EXCEPTION 'проверяющий связан с юрлицом: решение запрещено'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER kyb_verifications_no_self_review
    BEFORE INSERT OR UPDATE ON kyc.kyb_verifications
    FOR EACH ROW EXECUTE FUNCTION kyc.forbid_self_review_kyb();

-- ------------------------------------------ поиск по публичной части карточки
-- Существующий search_tsv включает description, а описание проекта публичным
-- НЕ является. Отдать его роли анонимного каталога нельзя даже в виде набора
-- лексем: по tsvector восстанавливается содержание. Поэтому у публичного поиска
-- отдельный индекс ровно по тем полям, которые и так видны в тизере.
ALTER TABLE lab.projects
    ADD COLUMN public_search_tsv TSVECTOR
    GENERATED ALWAYS AS (
        setweight(to_tsvector('russian'::regconfig, coalesce(title, '')), 'A') ||
        setweight(to_tsvector('russian'::regconfig, coalesce(tagline, '')), 'B')
    ) STORED;

CREATE INDEX projects_public_fts ON lab.projects USING GIN (public_search_tsv);

COMMENT ON COLUMN lab.projects.public_search_tsv IS
    'Поисковый вектор ТОЛЬКО по публичным полям тизера (title, tagline). '
    'description сюда не входит намеренно: он доступен по подписке, а не всем.';

GRANT SELECT (public_search_tsv) ON lab.projects TO app_public_read;

-- ------------------------------------------------------------------ права
-- Функции вызываются триггерами от имени владельца таблицы; отдельный GRANT
-- на них ролям приложения не требуется и намеренно не выдаётся.
COMMENT ON FUNCTION kyc.forbid_self_review() IS
    'Второй контур защиты: сервисный слой проверяет то же самое, но БД — последний рубеж.';
COMMENT ON FUNCTION kyc.forbid_self_review_kyb() IS
    'Проверяющий не может быть владельцем или участником проверяемого юрлица.';
