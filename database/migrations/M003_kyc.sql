-- =============================================================================
-- M003 — kyc
-- Верификация физлиц (KYC) и юрлиц (KYB), бенефициары, участники юрлица.
-- Источник: Database_Launch.md §4.
--
-- Все документы шифруются ДО загрузки в S3 (envelope encryption, KEK-домены
-- kyc_documents / kyb_documents). В БД хранится только s3_key и wrapped DEK.
-- =============================================================================

CREATE TABLE kyc.business_entities (
    id                           UUID PRIMARY KEY,
    legal_name                   TEXT NOT NULL,
    legal_form                   TEXT,
    inn_ciphertext               BYTEA,
    ogrn_ciphertext              BYTEA,
    entity_wrapped_dek           BYTEA,
    inn_hmac                     BYTEA,                      -- blind index
    jurisdiction                 CHAR(2) NOT NULL,
    registry_status              TEXT NOT NULL DEFAULT 'unknown' CHECK (registry_status IN
                                 ('active','liquidating','liquidated','unknown')),
    registry_checked_at          TIMESTAMPTZ,
    registry_payload_ciphertext  BYTEA,
    registry_payload_wrapped_dek BYTEA,
    owner_user_id                UUID NOT NULL REFERENCES identity.users(id),
    created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at                   TIMESTAMPTZ,
    CHECK ((inn_ciphertext IS NULL) = (inn_hmac IS NULL)),
    CHECK (inn_ciphertext IS NULL OR entity_wrapped_dek IS NOT NULL),
    CHECK ((registry_payload_ciphertext IS NULL) = (registry_payload_wrapped_dek IS NULL))
);
CREATE UNIQUE INDEX business_entities_inn_uq
    ON kyc.business_entities (inn_hmac, jurisdiction) WHERE deleted_at IS NULL;
CREATE INDEX business_entities_owner ON kyc.business_entities (owner_user_id) WHERE deleted_at IS NULL;

CREATE TABLE kyc.kyc_verifications (
    id                   UUID PRIMARY KEY,
    user_id              UUID NOT NULL REFERENCES identity.users(id),
    kind                 TEXT NOT NULL CHECK (kind IN ('identity','investor_status','accredited')),
    status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                         ('pending','in_review','approved','rejected','verification_pending')),
    provider             TEXT CHECK (provider IN ('sumsub_class','smev','manual')),
    provider_ref         TEXT,
    doc_type             TEXT CHECK (doc_type IN
                         ('passport','foreign_passport','id_card','driver_license')),
    doc_country          CHAR(2),
    liveness_result      TEXT CHECK (liveness_result IN ('passed','failed','not_required')),
    pep_status           TEXT NOT NULL DEFAULT 'unknown' CHECK (pep_status IN
                         ('unknown','clear','match','review')),
    sanctions_status     TEXT NOT NULL DEFAULT 'unknown' CHECK (sanctions_status IN
                         ('unknown','clear','match','review')),
    risk_level           TEXT CHECK (risk_level IN ('low','medium','high','prohibited')),
    entity_id            UUID REFERENCES kyc.business_entities(id),
    evidence_ref         TEXT,                               -- s3_key; KEK-домен kyc_documents
    evidence_wrapped_dek BYTEA,
    rejection_reason     TEXT,
    reviewed_by          UUID REFERENCES identity.users(id),
    decided_at           TIMESTAMPTZ,
    expires_at           TIMESTAMPTZ,
    next_review_at       TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((evidence_ref IS NULL) = (evidence_wrapped_dek IS NULL)),
    CHECK (status NOT IN ('approved','rejected') OR decided_at IS NOT NULL),
    CHECK (status <> 'rejected' OR rejection_reason IS NOT NULL)
);
CREATE INDEX kyc_user ON kyc.kyc_verifications (user_id, created_at DESC);
CREATE INDEX kyc_review_queue ON kyc.kyc_verifications (status, created_at)
    WHERE status IN ('pending','in_review');
CREATE INDEX kyc_next_review ON kyc.kyc_verifications (next_review_at)
    WHERE status = 'approved' AND next_review_at IS NOT NULL;

COMMENT ON TABLE kyc.kyc_verifications IS
    'Статус меняет только сервер. Обязательность: инвестор — при оформлении подписки; '
    'основатель — при публикации листинга.';

CREATE TABLE kyc.kyb_verifications (
    id                            UUID PRIMARY KEY,
    entity_id                     UUID NOT NULL REFERENCES kyc.business_entities(id),
    kind                          TEXT NOT NULL CHECK (kind IN
                                  ('registry_check','beneficial_owners','accreditation','annual_review')),
    status                        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                                  ('pending','in_review','approved','rejected','verification_pending')),
    provider                      TEXT CHECK (provider IN ('smev','egrul_api','kyc_provider','manual')),
    provider_ref                  TEXT,
    evidence_ref                  TEXT,                      -- KEK-домен kyb_documents
    evidence_wrapped_dek          BYTEA,
    beneficial_owners_ciphertext  BYTEA,
    beneficial_owners_wrapped_dek BYTEA,
    rejection_reason              TEXT,
    reviewed_by                   UUID REFERENCES identity.users(id),
    decided_at                    TIMESTAMPTZ,
    expires_at                    TIMESTAMPTZ,
    next_review_at                TIMESTAMPTZ,
    created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (reviewed_by IS NULL OR status IN ('approved','rejected')),
    CHECK ((evidence_ref IS NULL) = (evidence_wrapped_dek IS NULL)),
    CHECK ((beneficial_owners_ciphertext IS NULL) = (beneficial_owners_wrapped_dek IS NULL))
);
CREATE INDEX kyb_entity ON kyc.kyb_verifications (entity_id, created_at DESC);
CREATE INDEX kyb_review_queue ON kyc.kyb_verifications (status, created_at)
    WHERE status IN ('pending','in_review');

CREATE TABLE kyc.entity_members (
    entity_id   UUID NOT NULL REFERENCES kyc.business_entities(id),
    user_id     UUID NOT NULL REFERENCES identity.users(id),
    member_role TEXT NOT NULL CHECK (member_role IN
                ('signatory','beneficial_owner','representative')),
    share_pct   NUMERIC(5,2) CHECK (share_pct > 0 AND share_pct <= 100),
    verified_at TIMESTAMPTZ,
    PRIMARY KEY (entity_id, user_id, member_role)
);
CREATE INDEX entity_members_user ON kyc.entity_members (user_id);

-- Сумма долей бенефициаров ≤ 100%. Проверка сериализуется advisory-локом по
-- entity_id, иначе две параллельные вставки по 60% пройдут обе.
CREATE OR REPLACE FUNCTION kyc.enforce_beneficial_share_limit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, kyc, public
AS $$
DECLARE
    v_total NUMERIC(6,2);
BEGIN
    IF NEW.member_role <> 'beneficial_owner' OR NEW.share_pct IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('kyc.entity_members:' || NEW.entity_id::text, 0));
    SELECT coalesce(sum(share_pct), 0) INTO v_total
    FROM kyc.entity_members
    WHERE entity_id = NEW.entity_id
      AND member_role = 'beneficial_owner'
      AND NOT (user_id = NEW.user_id AND member_role = NEW.member_role);
    IF v_total + NEW.share_pct > 100 THEN
        RAISE EXCEPTION 'beneficial owner shares exceed 100%% for entity % (% + %)',
            NEW.entity_id, v_total, NEW.share_pct USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER entity_members_share_limit
    BEFORE INSERT OR UPDATE ON kyc.entity_members
    FOR EACH ROW EXECUTE FUNCTION kyc.enforce_beneficial_share_limit();

-- Отложенный FK из M002.
ALTER TABLE identity.investor_profiles
    ADD CONSTRAINT investor_entity_fk FOREIGN KEY (entity_id) REFERENCES kyc.business_entities(id);

-- --------------------------------------------- вспомогательные предикаты доступа
CREATE OR REPLACE FUNCTION kyc.is_entity_member(p_entity_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, kyc, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM kyc.entity_members em
        WHERE em.entity_id = p_entity_id AND em.user_id = p_user_id
    );
$$;

CREATE OR REPLACE FUNCTION kyc.is_entity_signatory(p_entity_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, kyc, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM kyc.entity_members em
        WHERE em.entity_id = p_entity_id
          AND em.user_id = p_user_id
          AND em.member_role IN ('signatory','representative')
    );
$$;

-- Актуальность KYC пользователя: единая точка для биллинга и инвестконтура.
CREATE OR REPLACE FUNCTION kyc.has_valid_kyc(p_user_id UUID, p_kind TEXT DEFAULT 'identity')
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, kyc, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM kyc.kyc_verifications v
        WHERE v.user_id = p_user_id
          AND v.kind = p_kind
          AND v.status = 'approved'
          AND (v.expires_at IS NULL OR v.expires_at > now())
          AND coalesce(v.risk_level, 'low') <> 'prohibited'
          AND v.sanctions_status <> 'match'
    );
$$;

CREATE OR REPLACE FUNCTION kyc.has_valid_kyb(p_entity_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = pg_catalog, kyc, public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM kyc.kyb_verifications v
        JOIN kyc.business_entities e ON e.id = v.entity_id
        WHERE v.entity_id = p_entity_id
          AND v.kind = 'registry_check'
          AND v.status = 'approved'
          AND (v.expires_at IS NULL OR v.expires_at > now())
          AND e.registry_status = 'active'
          AND e.deleted_at IS NULL
    );
$$;

-- ------------------------------------------------------------------------ RLS
ALTER TABLE kyc.kyc_verifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc.kyc_verifications  FORCE  ROW LEVEL SECURITY;
ALTER TABLE kyc.business_entities  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc.business_entities  FORCE  ROW LEVEL SECURITY;
ALTER TABLE kyc.kyb_verifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc.kyb_verifications  FORCE  ROW LEVEL SECURITY;
ALTER TABLE kyc.entity_members     ENABLE ROW LEVEL SECURITY;
ALTER TABLE kyc.entity_members     FORCE  ROW LEVEL SECURITY;

-- Свою верификацию видит владелец; решения принимает только комплаенс (admin).
CREATE POLICY kyc_own_select ON kyc.kyc_verifications FOR SELECT TO app_backend USING (
    user_id = app.current_user_id() OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY kyc_insert ON kyc.kyc_verifications FOR INSERT TO app_backend WITH CHECK (
    user_id = app.current_user_id() OR app.has_role('admin'));
-- Решение по верификации — только комплаенс. Пользователь не может сам себя одобрить.
CREATE POLICY kyc_decide_admin ON kyc.kyc_verifications FOR UPDATE TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY entities_member_select ON kyc.business_entities FOR SELECT TO app_backend USING (
    owner_user_id = app.current_user_id()
    OR kyc.is_entity_member(id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY entities_insert ON kyc.business_entities FOR INSERT TO app_backend WITH CHECK (
    owner_user_id = app.current_user_id() OR app.has_role('admin'));
CREATE POLICY entities_update ON kyc.business_entities FOR UPDATE TO app_backend
    USING (owner_user_id = app.current_user_id() OR app.has_role('admin'))
    WITH CHECK (owner_user_id = app.current_user_id() OR app.has_role('admin'));

CREATE POLICY kyb_member_select ON kyc.kyb_verifications FOR SELECT TO app_backend USING (
    kyc.is_entity_member(entity_id, app.current_user_id())
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY kyb_insert ON kyc.kyb_verifications FOR INSERT TO app_backend WITH CHECK (
    kyc.is_entity_signatory(entity_id, app.current_user_id()) OR app.has_role('admin'));
CREATE POLICY kyb_decide_admin ON kyc.kyb_verifications FOR UPDATE TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- ВАЖНО: эта политика намеренно НЕ вызывает kyc.is_entity_member().
-- Предикат сам читает entity_members, а политика, ссылающаяся на собственную
-- таблицу, даёт «infinite recursion detected in policy». Ограничение строками
-- текущего пользователя — ровно то, что нужно предикату: он проверяет
-- членство ВЫЗЫВАЮЩЕГО. Состав юрлица целиком отдаётся через сервисный слой.
CREATE POLICY entity_members_select ON kyc.entity_members FOR SELECT TO app_backend USING (
    user_id = app.current_user_id()
    OR app.has_role('admin') OR app.has_role('organizer'));
CREATE POLICY entity_members_insert ON kyc.entity_members FOR INSERT TO app_backend WITH CHECK (
    app.has_role('admin')
    OR EXISTS (SELECT 1 FROM kyc.business_entities e
               WHERE e.id = entity_members.entity_id
                 AND e.owner_user_id = app.current_user_id()));
CREATE POLICY entity_members_update ON kyc.entity_members FOR UPDATE TO app_backend
    USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

-- Инвестконтуру нужен только факт членства и валидность проверок, не документы.
CREATE POLICY entity_members_investments_read ON kyc.entity_members FOR SELECT
    TO app_investments USING (true);
CREATE POLICY entities_investments_read ON kyc.business_entities FOR SELECT
    TO app_investments USING (true);
CREATE POLICY kyb_investments_read ON kyc.kyb_verifications FOR SELECT
    TO app_investments USING (true);
CREATE POLICY kyc_investments_read ON kyc.kyc_verifications FOR SELECT
    TO app_investments USING (true);

-- ---------------------------------------------------------------------- права
GRANT SELECT, INSERT, UPDATE ON kyc.kyc_verifications, kyc.business_entities,
    kyc.kyb_verifications, kyc.entity_members TO app_backend;
GRANT SELECT ON kyc.entity_members, kyc.business_entities, kyc.kyb_verifications,
    kyc.kyc_verifications TO app_investments;
GRANT SELECT ON kyc.entity_members, kyc.business_entities TO app_billing;
GRANT EXECUTE ON FUNCTION kyc.is_entity_member(UUID, UUID), kyc.is_entity_signatory(UUID, UUID),
    kyc.has_valid_kyc(UUID, TEXT), kyc.has_valid_kyb(UUID)
    TO app_backend, app_investments, app_billing, app_integration;
