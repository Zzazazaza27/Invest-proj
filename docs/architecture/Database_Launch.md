# DATABASE_LAUNCH.md — база данных первого сервиса: LAUNCH (UNICORN LAB)

> **Версия:** 3.0 · **Дата:** 09.08.2026 · **СУБД:** PostgreSQL 16+
> **Основание:** `docs/architecture/Database.md` (целевая модель экосистемы), `docs/architecture/Architect_Launch.md` v3.0 (российский ОИП, границы сервиса и модель монетизации).
> **Принцип:** база автономна для Launch как российского оператора инвестиционной платформы: проекты, предложения, договоры инвестирования, номинальный счёт, транши, подписки и вознаграждение оператора. Инвестиционный principal хранится в `investments.*` и никогда не смешивается с платежами в пользу платформы в `billing.*`. Подключение Unicorn Capital и медиаконтура Шоу выполняется через Integration API, события и OIDC; прямой доступ чужих сервисов к этой БД запрещён.
> **Изменения v3.0:** добавлен regulated core `investments`; комиссия заменена версионируемым вознаграждением ОИП 10%/5%; база — полная сумма договора, однократный триггер — обе подписи плюс подтверждённый первый транш; тарифы и fee schedule версионируются; invoice отделён от payment; уточнены RLS, согласия, статусы выпуска в Capital и границы будущего выноса доменов.

> ---
>
> **СТАТУС НА 2026-09-03: частично актуален.** Документ написан 09.08.2026 и с
> тех пор не обновлялся, тогда как схема выросла с 11 миграций до 71
> (последняя — M070).
>
> **Чему верить.** Принципы организации данных: разделение по доменным схемам,
> роль приложения без `BYPASSRLS`, изоляция инвестиционного principal в
> `investments.*` от платежей платформы в `billing.*`, подход к RLS и согласиям.
> Код ссылается на §1, §10, §12 и §16 как на обоснование решений.
>
> **Чему не верить.** Составу таблиц и полей: 60 миграций после M011
> здесь не отражены, 22 таблицы из 83 не описаны вовсе, схема `content`
> отсутствует целиком. **Источник правды по схеме — `database/migrations/`**,
> а не этот документ.
>
> Дублировать схему в документе — причина, по которой он и разошёлся с кодом.
> Правильное направление правки: со временем убрать отсюда фактическую схему,
> оставив принципы, и за составом таблиц отправлять в миграции.

---

## 1. Организация: доменные схемы PostgreSQL

Одна БД `unicorn_launch`, одиннадцать схем. Схема = граница владения данными внутри модульного монолита. Межсхемные FK допустимы в Launch; при будущем выносе они заменяются API/событиями и локальными проекциями.

| Схема | Назначение | Таблицы |
|---|---|---|
| `identity` | Аккаунты, роли, вход, согласия и события согласий, профили инвесторов | 8 |
| `kyc` | Верификация физлиц и юрлиц | 4 |
| `lab` | Проекты, листинги, материалы | 7 |
| `investments` | Предложения, договоры инвестирования, транши, операции номинального счёта | 4 |
| `scoring` | Паспорта, факты, IRS, карты готовности, роадмапы | 8 |
| `experts` | Экспертный совет | 5 |
| `seasons` | Сезонный метроном, золотые билеты | 2 |
| `comms` | Уведомления (push/telegram/email/sms/inapp), устройства | 4 |
| `billing` | Версии тарифов и fee schedule, подписки, начисления ОИП, инвойсы и оплаты | 6 |
| `audit` | Журнал событий, outbox, ключи, фичефлаги, AI-графы | 8 |
| `integration` | Сервисные аккаунты будущих платформ, вебхуки, внешние ссылки | 4 |
| **Итого** | | **60 таблиц** |

**Зарезервировано, но НЕ создаётся** (схемы появятся вместе с Capital): `capital` (окна, интересы, investor_tiers, matches), `auctions` (auctions, auction_bids), `dataroom` (5 таблиц), `deal` (allocations, расширенные deal_documents). Их DDL готов в `docs/architecture/Database.md` §2.5–2.8 и §6. Швы под них — в §3.

### Общие правила DDL

- PK — UUIDv7 (генерация в приложении или `pg_uuidv7`-расширение).
- Расширения: `pgcrypto`, `pg_uuidv7`, `pgvector` (vector(1536), HNSW), `pg_partman` 5.x.
- Деньги — `NUMERIC(14,2) + CHAR(3) currency`; никогда не FLOAT. Суммы инвестиционных договоров и траншей в Launch v1 — только RUB; расширение валют требует отдельной версии Правил и FX-policy. Проценты вознаграждения берутся только из версионируемого `billing.fee_schedules` и snapshot-ятся в начисление.
- Soft delete: `deleted_at`; частичные UQ с `WHERE deleted_at IS NULL`.
- Все таблицы с пользовательскими данными — `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`; бэкенд-роли БЕЗ `BYPASSRLS`. В этом документе приведены ключевые политики; полный manifest «таблица × роль × операция» и фактические `ALTER TABLE` входят в каждую миграцию и проверяются отрицательными тестами.
- Session-контекст: `SET LOCAL app.current_user_id`, `app.current_roles` на каждую транзакцию.
- Роли БД: `app_public_read` (только allowlist тизера), `app_backend` (OLTP), `app_notifications` (доставка), `app_investments` (предложения, договоры и банковские события), `app_integration` (Integration API, read-mostly), `app_billing` (начисления/инвойсы/платежи), `app_readonly` (аналитика). Сервисные роли получают явные `TO role` RLS-политики; одного GRANT при включённом RLS недостаточно.

---

## 2. identity — аккаунты, согласия, инвесторы

```sql
CREATE SCHEMA identity;

CREATE TABLE identity.users (
    id              UUID PRIMARY KEY,                        -- UUIDv7
    email_ciphertext BYTEA,
    phone_ciphertext BYTEA,
    contact_wrapped_dek BYTEA,
    email_hmac      BYTEA,                                   -- blind index HMAC-SHA256 (KEK search_index)
    phone_hmac      BYTEA,
    password_hash   TEXT,                                    -- Argon2id; NULL при соц-входе
    display_name    TEXT NOT NULL DEFAULT '',
    primary_role    TEXT NOT NULL DEFAULT 'founder' CHECK (primary_role IN
                    ('founder','investor','expert','corporate','organizer','admin','showrunner')),
                    -- corporate/showrunner зарезервированы под Capital и Шоу
    status          TEXT NOT NULL DEFAULT 'pending_consents' CHECK (status IN
                    ('pending_consents','active','suspended','deleted')),
                    -- 'active' только после platform_rules+tos+pdn+commission_terms (§2.1)
    locale          TEXT NOT NULL DEFAULT 'ru-RU',
    currency_pref   CHAR(3) NOT NULL DEFAULT 'RUB',
    home_contour    TEXT NOT NULL DEFAULT 'ru' CHECK (home_contour IN ('ru','cis','hub')),
    mfa_enabled     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    CHECK (email_ciphertext IS NOT NULL OR phone_ciphertext IS NOT NULL),
    CHECK ((email_ciphertext IS NULL) = (email_hmac IS NULL)),
    CHECK ((phone_ciphertext IS NULL) = (phone_hmac IS NULL)),
    CHECK (contact_wrapped_dek IS NOT NULL)
);
CREATE UNIQUE INDEX users_email_hmac_uq ON identity.users (email_hmac) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_phone_hmac_uq ON identity.users (phone_hmac) WHERE deleted_at IS NULL;

CREATE TABLE identity.user_roles (
    user_id     UUID NOT NULL REFERENCES identity.users(id),
    role        TEXT NOT NULL CHECK (role IN
                ('founder','investor','expert','corporate','organizer','admin','showrunner')),
    granted_by  UUID REFERENCES identity.users(id),
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at  TIMESTAMPTZ,
    PRIMARY KEY (user_id, role, granted_at)
);
CREATE UNIQUE INDEX user_roles_active_uq ON identity.user_roles (user_id, role) WHERE revoked_at IS NULL;

CREATE TABLE identity.auth_identities (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    provider        TEXT NOT NULL CHECK (provider IN ('email','phone','telegram','google','vk','apple')),
    provider_uid    TEXT NOT NULL,
    verified_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_uid)
);
```

OIDC/OAuth sessions, refresh tokens, WebAuthn credentials, MFA factors, recovery codes, signing keys and OAuth clients принадлежат отдельной БД проверенного IdP. `identity.users` хранит доменный профиль и связывается с IdP по неизменяемому subject; Launch не реализует протокол OIDC самостоятельно и не дублирует секреты IdP в `unicorn_launch`.

### 2.1. Согласия — включая обязательный акцепт тарифов и комиссии

```sql
-- APPEND-ONLY: исторический факт акцепта неизменяем.
-- Отзыв отзываемого ПДн-согласия — новая запись consent_events; договорные условия
-- прекращаются/изменяются только предусмотренным Правилами и законом способом.
CREATE TABLE identity.consents (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    kind            TEXT NOT NULL CHECK (kind IN
                    ('platform_rules','tos','pdn','commission_terms',
                     'marketing_communications','pdn_biometric')),
                    -- commission_terms: «Тарифы и комиссионные условия» — ОБЯЗАТЕЛЕН
                    -- для активации аккаунта обеих ролей (Architect_Launch §5.4)
    version         TEXT NOT NULL,                           -- версия документа (consent_templates)
    locale          TEXT NOT NULL DEFAULT 'ru-RU',
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_hash         BYTEA NOT NULL,
    user_agent_hash BYTEA,
    revoked_at      TIMESTAMPTZ,                             -- legacy-поле; новые отзывы — consent_events
    UNIQUE (user_id, kind, version),
    CHECK (kind NOT IN ('platform_rules','tos','pdn','commission_terms') OR revoked_at IS NULL)
);

-- Запрет любого изменения/удаления исторических акцептов.
CREATE OR REPLACE FUNCTION identity.forbid_consent_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
    RAISE EXCEPTION 'consents are immutable (kind=%)', OLD.kind;
END $$;
CREATE TRIGGER consents_immutable BEFORE UPDATE OR DELETE ON identity.consents
    FOR EACH ROW EXECUTE FUNCTION identity.forbid_consent_mutation();

-- APPEND-ONLY события жизненного цикла согласия. Отзыв не переписывает факт акцепта.
CREATE TABLE identity.consent_events (
    id              UUID PRIMARY KEY,
    consent_id      UUID NOT NULL REFERENCES identity.consents(id),
    event_type      TEXT NOT NULL CHECK (event_type IN ('withdrawn','processing_stopped','legal_basis_changed')),
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason          TEXT,
    actor_id        UUID REFERENCES identity.users(id),
    UNIQUE (consent_id, event_type, occurred_at)
);

-- Версионируемые тексты документов
CREATE TABLE identity.consent_templates (
    kind        TEXT NOT NULL,
    version     TEXT NOT NULL,
    locale      TEXT NOT NULL DEFAULT 'ru-RU',
    body_sha256 BYTEA NOT NULL,                              -- хеш текста; тело — в S3/репозитории
    s3_key      TEXT,
    published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at TIMESTAMPTZ,
    PRIMARY KEY (kind, version, locale)
);
CREATE UNIQUE INDEX consent_templates_current_uq
    ON identity.consent_templates (kind, locale) WHERE superseded_at IS NULL;
ALTER TABLE identity.consents
    ADD CONSTRAINT consents_template_fk
    FOREIGN KEY (kind, version, locale)
    REFERENCES identity.consent_templates(kind, version, locale);
-- Инвариант сервисного слоя (тест в CI): users.status='active' возможен только при
-- наличии акцептов АКТУАЛЬНЫХ версий platform_rules + tos + pdn + commission_terms.
-- При смене версии commission_terms: ре-акцепт обязателен до следующей платёжной
-- операции (grace 14 дней → приостановка платных функций, не аккаунта).

-- Согласия на публичный контур (шов к Шоу)
CREATE TABLE identity.publication_consents (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    project_id      UUID NOT NULL,                           -- FK → lab.projects (ALTER ниже)
    scope           TEXT NOT NULL CHECK (scope IN
                    ('episode_selection','episode_bootcamp','final_live','top100_public')),
    disclosed_fields JSONB NOT NULL DEFAULT '[]',
    document_version TEXT NOT NULL,
    document_sha256 BYTEA NOT NULL,
    accepted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,                             -- отзыв → lab.consent.publication_revoked
    CHECK (revoked_at IS NULL OR revoked_at >= accepted_at)
);
CREATE INDEX publication_consents_project ON identity.publication_consents (project_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX publication_consents_active_uq
    ON identity.publication_consents (user_id, project_id, scope) WHERE revoked_at IS NULL;

-- Профили инвесторов (минимум для Launch; расширенные tiers/mandate_embedding — Capital)
CREATE TABLE identity.investor_profiles (
    user_id         UUID PRIMARY KEY REFERENCES identity.users(id),
    about           TEXT,
    focus_taxonomy_ids UUID[],                               -- интересующие категории
    check_size_min  NUMERIC(14,2),
    check_size_max  NUMERIC(14,2),
    currency        CHAR(3) NOT NULL DEFAULT 'RUB',
    entity_id       UUID,                                    -- FK → kyc.business_entities (инвестор-юрлицо)
    kyc_status      TEXT NOT NULL DEFAULT 'none' CHECK (kyc_status IN
                    ('none','pending','approved','rejected')),  -- зеркало последнего kyc_verifications
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 3. Интеграционные швы, заложенные в модель

| Шов | Где реализован | Как использует следующая платформа |
|---|---|---|
| Роли Capital/Шоу | CHECK-списки `users.primary_role`, `user_roles.role` | `corporate`/`showrunner` активируются без миграции enum |
| Статус «готов к Capital» | `lab.projects.status` включает `'graduated'` | Capital создаёт листинг → Integration API сохраняет внешний ref, не меняя Launch listing_status |
| Тир раскрытия паспорта | `scoring.investment_passports.disclosure_tier` (`teaser/full/dataroom`) | Capital запрашивает `tier=full` по гранту |
| Событие выпуска | `audit.event_type_registry`: `lab.project.graduated` | Триггер создания листинга на Capital |
| Согласия на публичность | `identity.publication_consents` | Шоу публикует только при активном scope |
| Сервисные клиенты | `integration.service_accounts` + client_credentials + mTLS | Capital/Шоу — новые строки, не новый код |
| Внешние ссылки | `integration.external_refs` | Маппинг «проект Launch ↔ листинг Capital» при пути B |
| OIDC | issuer `id.unicorn.vc`, claim `roles` | Capital/Шоу — OAuth-клиенты, аккаунты едины |
| Регулируемые сделки | `investments.investment_agreements/tranches` + `billing.commission_accruals` | Capital получает агрегированную историю только через API/события |

---

## 4. kyc — верификация

```sql
CREATE SCHEMA kyc;

CREATE TABLE kyc.kyc_verifications (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    kind            TEXT NOT NULL CHECK (kind IN ('identity','investor_status','accredited')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','in_review','approved','rejected','verification_pending')),
    provider        TEXT CHECK (provider IN ('sumsub_class','smev','manual')),
    provider_ref    TEXT,
    doc_type        TEXT CHECK (doc_type IN ('passport','foreign_passport','id_card','driver_license')),
    doc_country     CHAR(2),
    liveness_result TEXT CHECK (liveness_result IN ('passed','failed','not_required')),
    pep_status      TEXT NOT NULL DEFAULT 'unknown' CHECK (pep_status IN ('unknown','clear','match','review')),
    sanctions_status TEXT NOT NULL DEFAULT 'unknown' CHECK (sanctions_status IN ('unknown','clear','match','review')),
    risk_level      TEXT CHECK (risk_level IN ('low','medium','high','prohibited')),
    entity_id       UUID,                                    -- FK → business_entities (бенефициары KYB)
    evidence_ref    TEXT,                                    -- s3_key; шифруется ДО загрузки (KEK kyc_documents)
    evidence_wrapped_dek BYTEA,
    rejection_reason TEXT,
    reviewed_by     UUID REFERENCES identity.users(id),
    decided_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    next_review_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kyc_user ON kyc.kyc_verifications (user_id, created_at DESC);
-- verification_status меняется только сервером; прямого UPDATE клиентским ролям нет (RLS + GRANT).
-- Обязательность: инвестор — при оформлении подписки; основатель — при публикации листинга.

CREATE TABLE kyc.business_entities (
    id              UUID PRIMARY KEY,
    legal_name      TEXT NOT NULL,
    legal_form      TEXT,
    inn_ciphertext  BYTEA,
    ogrn_ciphertext BYTEA,
    entity_wrapped_dek BYTEA,
    inn_hmac        BYTEA,                                   -- blind index
    jurisdiction    CHAR(2) NOT NULL,
    registry_status TEXT NOT NULL DEFAULT 'unknown' CHECK (registry_status IN
                    ('active','liquidating','liquidated','unknown')),
    registry_checked_at TIMESTAMPTZ,
    registry_payload_ciphertext BYTEA,
    registry_payload_wrapped_dek BYTEA,
    owner_user_id   UUID NOT NULL REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    CHECK ((inn_ciphertext IS NULL) = (inn_hmac IS NULL)),
    CHECK (inn_ciphertext IS NULL OR entity_wrapped_dek IS NOT NULL)
);
CREATE UNIQUE INDEX business_entities_inn_uq
    ON kyc.business_entities (inn_hmac, jurisdiction) WHERE deleted_at IS NULL;

ALTER TABLE identity.investor_profiles
    ADD CONSTRAINT investor_entity_fk FOREIGN KEY (entity_id) REFERENCES kyc.business_entities(id);

CREATE TABLE kyc.kyb_verifications (
    id              UUID PRIMARY KEY,
    entity_id       UUID NOT NULL REFERENCES kyc.business_entities(id),
    kind            TEXT NOT NULL CHECK (kind IN
                    ('registry_check','beneficial_owners','accreditation','annual_review')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','in_review','approved','rejected','verification_pending')),
    provider        TEXT CHECK (provider IN ('smev','egrul_api','kyc_provider','manual')),
    provider_ref    TEXT,
    evidence_ref    TEXT,                                    -- KEK-домен kyb_documents
    evidence_wrapped_dek BYTEA,
    beneficial_owners_ciphertext BYTEA,
    beneficial_owners_wrapped_dek BYTEA,
    rejection_reason TEXT,
    reviewed_by     UUID REFERENCES identity.users(id),
    decided_at      TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    next_review_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (reviewed_by IS NULL OR status IN ('approved','rejected'))
);
-- Сумма долей beneficial_owner ≤100% и обязательность периодического/событийного
-- пересмотра KYC/KYB проверяются сериализуемыми доменными командами и CI-тестами.

CREATE TABLE kyc.entity_members (
    entity_id   UUID NOT NULL REFERENCES kyc.business_entities(id),
    user_id     UUID NOT NULL REFERENCES identity.users(id),
    member_role TEXT NOT NULL CHECK (member_role IN ('signatory','beneficial_owner','representative')),
    share_pct   NUMERIC(5,2) CHECK (share_pct > 0 AND share_pct <= 100),
    verified_at TIMESTAMPTZ,
    PRIMARY KEY (entity_id, user_id, member_role)
);

ALTER TABLE kyc.kyc_verifications
    ADD CONSTRAINT kyc_entity_fk FOREIGN KEY (entity_id) REFERENCES kyc.business_entities(id);
```

---

## 5. lab — проекты и листинги

```sql
CREATE SCHEMA lab;

CREATE TABLE lab.project_taxonomy (
    id          UUID PRIMARY KEY,
    parent_id   UUID REFERENCES lab.project_taxonomy(id),
    slug        TEXT NOT NULL UNIQUE,
    name_ru     TEXT NOT NULL,
    name_en     TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE lab.projects (
    id              UUID PRIMARY KEY,
    taxonomy_id     UUID REFERENCES lab.project_taxonomy(id),
    title           TEXT NOT NULL,
    tagline         TEXT,
    description     TEXT,
    stage           TEXT NOT NULL CHECK (stage IN ('idea','mvp','early_revenue','growth')),
    geo_country     CHAR(2),
    geo_region      TEXT,

    -- Запрос инвестиций — определяет тариф подписки (Architect_Launch §5.1)
    investment_ask  NUMERIC(14,2) NOT NULL CHECK (investment_ask > 0),
    ask_currency    CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (ask_currency = 'RUB'),
    required_plan_id UUID,                                   -- FK на конкретную версию billing.subscription_plans добавляется в M008

    -- Листинг на платформе
    listing_status  TEXT NOT NULL DEFAULT 'not_listed' CHECK (listing_status IN
                    ('not_listed','listed','suspended_billing','unlisted')),
                    -- listed: виден в каталоге; suspended_billing: подписка просрочена
                    -- (данные сохраняются); unlisted: снят владельцем/админом
    listed_at       TIMESTAMPTZ,
    teaser_jsonb    JSONB NOT NULL DEFAULT '{}',             -- публичный минимум: title, tagline, категория, стадия, ask-вилка

    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft','submitted','ai_review','expert_review','bootcamp',
                     'finalist','graduated','rejected','archived')),
                    -- status='graduated' — выпускник готов к шву Capital; не путать с listing_status
    season_id       UUID,                                    -- FK → seasons.seasons
    current_version_id UUID,                                 -- циклический FK → project_versions
    capital_ref     UUID,                                    -- ссылка на integration.external_refs после выпуска
    search_tsv      TSVECTOR,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX projects_season_status ON lab.projects (season_id, status);
CREATE INDEX projects_catalog ON lab.projects (listing_status, taxonomy_id, listed_at DESC)
    WHERE deleted_at IS NULL;
CREATE INDEX projects_ask ON lab.projects (investment_ask) WHERE listing_status = 'listed';
CREATE INDEX projects_fts ON lab.projects USING GIN (search_tsv);

-- Публичный каталог: только явный allowlist колонок. Свободный teaser_jsonb наружу не отдаётся.
CREATE VIEW lab.v_public_catalog WITH (security_invoker = true) AS
SELECT id, taxonomy_id, title, tagline, stage, geo_country,
       investment_ask, ask_currency, listed_at
FROM lab.projects
WHERE listing_status = 'listed' AND deleted_at IS NULL;

CREATE TABLE lab.founders_projects (
    project_id  UUID NOT NULL REFERENCES lab.projects(id),
    user_id     UUID NOT NULL REFERENCES identity.users(id),
    role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','cofounder')),
    equity_pct  NUMERIC(5,2) CHECK (equity_pct >= 0 AND equity_pct <= 100),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE TABLE lab.project_versions (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    season_id       UUID NOT NULL,
    version_no      INTEGER NOT NULL CHECK (version_no > 0),
    snapshot_jsonb  JSONB NOT NULL,                          -- неизменяемый снимок заявки
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, season_id, version_no),
    UNIQUE (project_id, id)
);
ALTER TABLE lab.projects
    ADD CONSTRAINT projects_current_version_fk
    FOREIGN KEY (id, current_version_id) REFERENCES lab.project_versions(project_id, id);
-- UPDATE/DELETE project_versions запрещаются GRANT + append-only trigger в M003.

CREATE TABLE lab.project_materials (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    type            TEXT NOT NULL CHECK (type IN ('deck','video','doc','product_link')),
    version         INTEGER NOT NULL DEFAULT 1,
    s3_key          TEXT,                                    -- шифрование per-object
    url             TEXT,
    parse_status    TEXT NOT NULL DEFAULT 'queued' CHECK (parse_status IN
                    ('queued','running','succeeded','failed','not_required')),
    uploaded_by     UUID NOT NULL REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, type, version),
    CHECK (version > 0),
    CHECK ((type = 'product_link' AND url IS NOT NULL AND s3_key IS NULL)
        OR (type <> 'product_link' AND s3_key IS NOT NULL AND url IS NULL))
);

CREATE TABLE lab.project_material_parses (
    id              UUID PRIMARY KEY,
    material_id     UUID NOT NULL REFERENCES lab.project_materials(id),
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','running','succeeded','failed')),
    extracted_jsonb JSONB,
    model_version   TEXT,
    error_detail    TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);

CREATE TABLE lab.project_duplicates (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    other_project_id UUID NOT NULL REFERENCES lab.projects(id),
    method          TEXT NOT NULL CHECK (method IN ('perceptual_hash','embedding')),
    similarity_score NUMERIC(5,4) NOT NULL,
    decision        TEXT NOT NULL DEFAULT 'flagged' CHECK (decision IN
                    ('flagged','cleared','confirmed_duplicate')),
    decided_by      UUID REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (project_id < other_project_id),
    CHECK (similarity_score >= 0 AND similarity_score <= 1),
    UNIQUE (project_id, other_project_id, method)
);

ALTER TABLE identity.publication_consents
    ADD CONSTRAINT publication_consents_project_fk
    FOREIGN KEY (project_id) REFERENCES lab.projects(id);
```

---

## 6. investments — регулируемый контур ОИП

Инвестиционные средства не являются выручкой платформы. `investments.*` хранит предложения, договоры и движение principal через номинальный счёт; `billing.*` начинается только с начисленного вознаграждения ОИП.

```sql
CREATE SCHEMA investments;

CREATE TABLE investments.investment_offers (
    id                  UUID PRIMARY KEY,
    project_id          UUID NOT NULL REFERENCES lab.projects(id),
    issuer_entity_id    UUID NOT NULL REFERENCES kyc.business_entities(id),
    instrument_type     TEXT NOT NULL CHECK (instrument_type IN
                        ('loan','security','utility_digital_right','dfa')),
    rules_version       TEXT NOT NULL,
    target_amount       NUMERIC(14,2) NOT NULL CHECK (target_amount > 0),
    min_investment      NUMERIC(14,2) NOT NULL CHECK (min_investment > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    terms_jsonb         JSONB NOT NULL,
    document_s3_key     TEXT NOT NULL,
    document_sha256     BYTEA NOT NULL,
    document_wrapped_dek BYTEA NOT NULL,
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                        ('draft','compliance_review','published','paused','closed','cancelled')),
    opens_at            TIMESTAMPTZ,
    closes_at           TIMESTAMPTZ,
    created_by          UUID NOT NULL REFERENCES identity.users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (target_amount >= min_investment),
    CHECK (closes_at IS NULL OR opens_at IS NULL OR closes_at > opens_at)
);
CREATE INDEX investment_offers_catalog ON investments.investment_offers (status, opens_at, closes_at);

CREATE TABLE investments.investment_agreements (
    id                  UUID PRIMARY KEY,
    offer_id            UUID NOT NULL REFERENCES investments.investment_offers(id),
    investor_id         UUID NOT NULL REFERENCES identity.users(id),
    contract_amount     NUMERIC(14,2) NOT NULL CHECK (contract_amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    fee_schedule_id     UUID NOT NULL,                       -- FK → billing.fee_schedules после M008
    document_s3_key     TEXT NOT NULL,
    document_sha256     BYTEA NOT NULL,
    document_wrapped_dek BYTEA NOT NULL,
    investor_signed_at  TIMESTAMPTZ,
    issuer_signed_at    TIMESTAMPTZ,
    investor_signature_evidence JSONB,
    issuer_signature_evidence   JSONB,
    status              TEXT NOT NULL DEFAULT 'pending_signatures' CHECK (status IN
                        ('pending_signatures','signed','awaiting_first_tranche',
                         'effective','completed','cancelled','defaulted')),
    idempotency_key     TEXT NOT NULL UNIQUE,
    effective_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (status NOT IN ('signed','awaiting_first_tranche','effective','completed','defaulted')
           OR (investor_signed_at IS NOT NULL AND issuer_signed_at IS NOT NULL)),
    CHECK (status NOT IN ('effective','completed','defaulted') OR effective_at IS NOT NULL)
);
CREATE INDEX investment_agreements_investor ON investments.investment_agreements (investor_id, status);
CREATE INDEX investment_agreements_offer ON investments.investment_agreements (offer_id, status);

CREATE TABLE investments.investment_tranches (
    id                  UUID PRIMARY KEY,
    agreement_id        UUID NOT NULL REFERENCES investments.investment_agreements(id),
    tranche_no          INTEGER NOT NULL CHECK (tranche_no > 0),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    status              TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN
                        ('scheduled','received_nominal','transferred_to_issuer',
                         'confirmed','returned','failed','disputed')),
    bank_transaction_ref TEXT,
    evidence_s3_key     TEXT,
    evidence_wrapped_dek BYTEA,
    received_nominal_at TIMESTAMPTZ,
    transferred_at      TIMESTAMPTZ,
    confirmed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agreement_id, tranche_no),
    UNIQUE (bank_transaction_ref),
    CHECK (status <> 'confirmed' OR (confirmed_at IS NOT NULL AND transferred_at IS NOT NULL))
);

CREATE TABLE investments.nominal_account_transactions (
    id                  UUID PRIMARY KEY,
    tranche_id          UUID REFERENCES investments.investment_tranches(id),
    bank_transaction_ref TEXT NOT NULL UNIQUE,
    direction           TEXT NOT NULL CHECK (direction IN ('incoming','to_issuer','return_to_investor')),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    booked_at           TIMESTAMPTZ NOT NULL,
    raw_statement_sha256 BYTEA NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Транзакционный инвариант `confirm_first_tranche`:** под блокировкой строки agreement подтверждает банковское событие, проверяет обе подписи и `tranche_no=1`, переводит agreement в `effective`, вставляет outbox/audit и вызывает создание единственного `billing.commission_accruals`. Повтор с тем же bank reference возвращает прежний результат. Клиентский API не может установить `confirmed`.

Доменные команды M005 также сериализованно проверяют: активную investor membership, актуальные KYC/KYB/AML, разрешённый Правилами `instrument_type`, лимиты инвестора и ЛПИ, сумму заключённых договоров относительно offer, сумму траншей относительно `contract_amount`, запрет аффилированной/self-deal операции и допустимость каждого перехода status. Эти проверки являются transaction-level инвариантами и имеют конкурентные тесты; UI-проверка не считается контролем.

---

## 7. scoring — паспорт, IRS, развитие

```sql
CREATE SCHEMA scoring;

CREATE TABLE scoring.score_models (
    id              UUID PRIMARY KEY,
    name            TEXT NOT NULL CHECK (name IN ('ai_score','irs','match_ranker')),
    version         TEXT NOT NULL,
    params_jsonb    JSONB NOT NULL,
    eval_metrics_jsonb JSONB,
    is_active       BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (name, version)
);
CREATE UNIQUE INDEX score_models_one_active
    ON scoring.score_models (name) WHERE is_active;

CREATE TABLE scoring.investment_passports (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    version         INTEGER NOT NULL,
    jsonb_data      JSONB NOT NULL,
    embedding       VECTOR(1536),
    disclosure_tier TEXT NOT NULL DEFAULT 'teaser' CHECK (disclosure_tier IN
                    ('teaser','full','dataroom')),
    sources         JSONB NOT NULL DEFAULT '[]',
    model_id        UUID REFERENCES scoring.score_models(id),
    published_at    TIMESTAMPTZ,
    superseded_at   TIMESTAMPTZ,
    UNIQUE (project_id, version)
);
CREATE INDEX passports_embedding_hnsw ON scoring.investment_passports
    USING hnsw (embedding vector_cosine_ops);
CREATE INDEX passports_jsonb ON scoring.investment_passports USING GIN (jsonb_data);
CREATE UNIQUE INDEX passports_one_current
    ON scoring.investment_passports (project_id) WHERE superseded_at IS NULL;

CREATE TABLE scoring.passport_facts (
    id              UUID PRIMARY KEY,
    passport_id     UUID NOT NULL REFERENCES scoring.investment_passports(id),
    category        TEXT NOT NULL CHECK (category IN
                    ('team','tech','market','competitors','legal','finance','traction','ip')),
    key             TEXT NOT NULL,
    value_jsonb     JSONB NOT NULL,                          -- finance/legal: per-field DEK
    value_wrapped_dek BYTEA,
    source_type     TEXT NOT NULL,
    source_ref      TEXT NOT NULL,
    confidence      NUMERIC(3,2) CHECK (confidence >= 0 AND confidence <= 1),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX passport_facts_lookup ON scoring.passport_facts (passport_id, category);

CREATE TABLE scoring.scores (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    passport_id     UUID REFERENCES scoring.investment_passports(id),
    axis            TEXT NOT NULL CHECK (axis IN
                    ('market','demand','competitive_edge','uniqueness','profitability',
                     'presentation_quality','scalability','investment_readiness','product_readiness')),
    value           NUMERIC(5,2) NOT NULL CHECK (value >= 0 AND value <= 100),
    confidence_low  NUMERIC(5,2) NOT NULL,
    confidence_high NUMERIC(5,2) NOT NULL,
    explanation     TEXT NOT NULL,
    sources         JSONB NOT NULL DEFAULT '[]',
    model_id        UUID REFERENCES scoring.score_models(id),
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (confidence_low >= 0 AND confidence_high <= 100),
    CHECK (confidence_low <= value AND value <= confidence_high)
);
CREATE INDEX scores_project ON scoring.scores (project_id, computed_at DESC);

CREATE TABLE scoring.irs_scores (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    value           NUMERIC(5,2) NOT NULL CHECK (value >= 0 AND value <= 100),
    previous_value  NUMERIC(5,2),
    delta           NUMERIC(5,2),
    model_id        UUID REFERENCES scoring.score_models(id),
    computed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((previous_value IS NULL AND delta IS NULL)
        OR (previous_value IS NOT NULL AND delta = value - previous_value))
);
CREATE INDEX irs_project ON scoring.irs_scores (project_id, computed_at DESC);

CREATE TABLE scoring.readiness_map (
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    dimension       TEXT NOT NULL CHECK (dimension IN
                    ('problem','solution','product','tech','team','market','competition',
                     'business_model','unit_economics','legal','finance','pitch','data_room')),
    level           TEXT NOT NULL CHECK (level IN ('low','medium','high')),
    recommendations JSONB NOT NULL DEFAULT '[]',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, dimension)
);

CREATE TABLE scoring.roadmaps (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    generated_by    TEXT NOT NULL CHECK (generated_by IN ('ai','expert')),
    author_id       UUID REFERENCES identity.users(id),
    is_active       BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scoring.roadmap_steps (
    id              UUID PRIMARY KEY,
    roadmap_id      UUID NOT NULL REFERENCES scoring.roadmaps(id),
    title           TEXT NOT NULL,
    description     TEXT,
    dimension       TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','in_progress','completed','skipped')),
    priority        INTEGER NOT NULL DEFAULT 0,
    order_index     INTEGER NOT NULL,
    completed_at    TIMESTAMPTZ
);
CREATE INDEX roadmap_steps_roadmap ON scoring.roadmap_steps (roadmap_id, order_index);
```

---

## 8. experts — экспертный совет

```sql
CREATE SCHEMA experts;

CREATE TABLE experts.experts (
    user_id         UUID PRIMARY KEY REFERENCES identity.users(id),
    expertise_tags  TEXT[] NOT NULL DEFAULT '{}',
    bio             TEXT,
    capacity_per_week INTEGER NOT NULL DEFAULT 5,
    is_public       BOOLEAN NOT NULL DEFAULT false,
    rating          NUMERIC(4,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experts.expert_assignments (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    expert_id       UUID NOT NULL REFERENCES experts.experts(user_id),
    season_id       UUID,
    assigned_reason TEXT NOT NULL CHECK (assigned_reason IN
                    ('auto_taxonomy','manual','third_reviewer')),
    status          TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN
                    ('assigned','accepted','declined','completed','expired')),
    due_at          TIMESTAMPTZ NOT NULL,
    assigned_by     UUID REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX assignments_expert ON experts.expert_assignments (expert_id, status);
CREATE INDEX assignments_project ON experts.expert_assignments (project_id);

CREATE TABLE experts.expert_reviews (
    id              UUID PRIMARY KEY,
    assignment_id   UUID NOT NULL UNIQUE REFERENCES experts.expert_assignments(id),
    rubric_scores_jsonb JSONB NOT NULL
        CHECK (rubric_scores_jsonb ?& ARRAY['team','product','strategy','legal','finmodel','scalability']),
    comment         TEXT,
    recommendation  TEXT NOT NULL CHECK (recommendation IN ('pass','fail','needs_review')),
    submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experts.expert_conflict_declarations (
    id              UUID PRIMARY KEY,
    expert_id       UUID NOT NULL REFERENCES experts.experts(user_id),
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    description     TEXT NOT NULL,
    resolution      TEXT CHECK (resolution IN ('recused','approved_with_disclosure')),
    resolved_by     UUID REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE experts.review_consensus (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    season_id       UUID,
    discrepancy_score NUMERIC(5,2),
    third_reviewer_id UUID REFERENCES experts.experts(user_id),
    final_decision  TEXT NOT NULL CHECK (final_decision IN ('pass','fail','needs_review')),
    decided_by      UUID NOT NULL REFERENCES identity.users(id),
    decided_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 9. seasons — метроном и конкурс

```sql
CREATE SCHEMA seasons;

CREATE TABLE seasons.seasons (
    id              UUID PRIMARY KEY,
    number          INTEGER NOT NULL UNIQUE,
    title           TEXT,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                    ('draft','applications_open','review','bootcamp','final','closed')),
    investor_cap    INTEGER,
    new_member_cap_per_year INTEGER,
    funnel_config_jsonb JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);

ALTER TABLE lab.projects
    ADD CONSTRAINT projects_season_fk FOREIGN KEY (season_id) REFERENCES seasons.seasons(id);
ALTER TABLE lab.project_versions
    ADD CONSTRAINT versions_season_fk FOREIGN KEY (season_id) REFERENCES seasons.seasons(id);

CREATE TABLE seasons.golden_tickets (
    id              UUID PRIMARY KEY,
    project_id      UUID NOT NULL REFERENCES lab.projects(id),
    season_id       UUID NOT NULL REFERENCES seasons.seasons(id),
    granted_by      UUID NOT NULL REFERENCES identity.users(id),
    reason          TEXT NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, season_id)
);
CREATE OR REPLACE FUNCTION seasons.enforce_golden_ticket_limit() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.granted_by::text || ':' || NEW.season_id::text, 0));
    IF (SELECT count(*) FROM seasons.golden_tickets
        WHERE granted_by = NEW.granted_by AND season_id = NEW.season_id) >= 2 THEN
        RAISE EXCEPTION 'golden ticket limit reached for this season';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER golden_tickets_limit BEFORE INSERT ON seasons.golden_tickets
    FOR EACH ROW EXECUTE FUNCTION seasons.enforce_golden_ticket_limit();

CREATE MATERIALIZED VIEW seasons.mv_season_rating AS
SELECT p.season_id, p.id AS project_id, p.title,
       i.value AS irs, i.computed_at,
       row_number() OVER (PARTITION BY p.season_id ORDER BY i.value DESC, p.id) AS rank
FROM lab.projects p
JOIN LATERAL (
    SELECT value, computed_at FROM scoring.irs_scores s
    WHERE s.project_id = p.id ORDER BY computed_at DESC LIMIT 1
) i ON true
WHERE p.status IN ('expert_review','bootcamp','finalist','graduated') AND p.deleted_at IS NULL;
CREATE UNIQUE INDEX mv_season_rating_uq ON seasons.mv_season_rating (season_id, project_id);
```

---

## 10. comms — уведомления (push / telegram / email / sms / inapp)

```sql
CREATE SCHEMA comms;

CREATE TABLE comms.user_devices (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    platform        TEXT NOT NULL CHECK (platform IN ('ios','android','web_pwa')),
    push_provider   TEXT NOT NULL CHECK (push_provider IN ('fcm','apns','web_push')),
    push_token      TEXT NOT NULL,
    device_name     TEXT,
    app_version     TEXT,
    locale          TEXT,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_devices_token_uq
    ON comms.user_devices (push_provider, push_token) WHERE revoked_at IS NULL;
CREATE INDEX user_devices_active ON comms.user_devices (user_id) WHERE revoked_at IS NULL;

CREATE TABLE comms.notification_templates (
    id              UUID PRIMARY KEY,
    code            TEXT NOT NULL,          -- 'project.scored','investment.agreement.signed','billing.payment_failed',…
    channel         TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    locale          TEXT NOT NULL DEFAULT 'ru-RU',
    version         INTEGER NOT NULL DEFAULT 1,
    title_template  TEXT,
    body_template   TEXT NOT NULL,
    fallback_chain  TEXT[] NOT NULL DEFAULT '{}',
    is_critical     BOOLEAN NOT NULL DEFAULT false,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (code, channel, locale, version)
);
CREATE UNIQUE INDEX notification_templates_one_active
    ON comms.notification_templates (code, channel, locale) WHERE is_active;

CREATE TABLE comms.notifications (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    device_id       UUID REFERENCES comms.user_devices(id),
    channel         TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    template_code   TEXT NOT NULL,
    payload_jsonb   JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','sending','sent','failed','skipped_by_preference')),
    provider        TEXT,
    provider_ref    TEXT,
    dedup_key       TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    error_detail    TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_dedup_uq
    ON comms.notifications (user_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX notifications_queue ON comms.notifications (status, channel, created_at)
    WHERE status = 'queued';
CREATE INDEX notifications_user ON comms.notifications (user_id, created_at DESC);

CREATE TABLE comms.notification_preferences (
    user_id         UUID NOT NULL REFERENCES identity.users(id),
    channel         TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    topic           TEXT NOT NULL DEFAULT 'all' CHECK (topic IN
                    ('all','projects','deals','billing','experts','seasons','messages','security','marketing')),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    quiet_hours_tz  TEXT,
    quiet_from      TIME,
    quiet_to        TIME,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, channel, topic),
    CHECK (topic NOT IN ('security','billing') OR enabled = true)
    -- security и критичные биллинг-уведомления (просрочка подписки, счёт комиссии) не отключаются
);
```

Политика каналов: сервисные — `push → telegram → email`; security — `sms + email`; биллинг-критичные (просрочка, счёт на комиссию) — `push + email + sms`; маркетинг — только при `consents(kind='marketing_communications')`.

---

## 11. billing — тарифы, подписки и вознаграждение ОИП

### 11.1. Версионируемые тарифы и fee schedule

```sql
CREATE SCHEMA billing;

CREATE TABLE billing.subscription_plans (
    id              UUID PRIMARY KEY,
    code            TEXT NOT NULL CHECK (code IN
                    ('founder_t1','founder_t2','founder_t3','founder_t4','founder_t5',
                     'investor_membership')),
    version         INTEGER NOT NULL CHECK (version > 0),
    audience        TEXT NOT NULL CHECK (audience IN ('founder','investor')),
    name            TEXT NOT NULL,
    ask_limit       NUMERIC(14,2),           -- верхняя граница investment_ask для founder-тарифов:
                    -- t1=1 000 000 · t2=10 000 000 · t3=100 000 000 · t4=1 000 000 000 · t5=NULL (свыше)
    individual_pricing BOOLEAN NOT NULL DEFAULT false,   -- t5: подготовительная программа; не повышает лимит ОИП
    price           NUMERIC(14,2) CHECK (price IS NULL OR price >= 0),
                    -- t1=4 990 · t2=9 990 · t3=29 990 · t4=199 990 · investor=100 000 · t5=NULL
    currency        CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    billing_period  TEXT NOT NULL DEFAULT 'monthly' CHECK (billing_period IN ('monthly','yearly')),
    features_jsonb  JSONB NOT NULL DEFAULT '{}',
    valid_from      TIMESTAMPTZ NOT NULL,
    valid_to        TIMESTAMPTZ,
    published_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (individual_pricing OR price IS NOT NULL),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (code, version)
);

CREATE TABLE billing.fee_schedules (
    id                  UUID PRIMARY KEY,
    code                TEXT NOT NULL,
    version             INTEGER NOT NULL CHECK (version > 0),
    investor_fee_pct    NUMERIC(5,2) NOT NULL CHECK (investor_fee_pct >= 0 AND investor_fee_pct <= 100),
    issuer_fee_pct      NUMERIC(5,2) NOT NULL CHECK (issuer_fee_pct >= 0 AND issuer_fee_pct <= 100),
    rules_version       TEXT NOT NULL,
    valid_from          TIMESTAMPTZ NOT NULL,
    valid_to            TIMESTAMPTZ,
    published_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (valid_to IS NULL OR valid_to > valid_from),
    UNIQUE (code, version)
);
-- Seed v1: code='operator_success_fee', investor_fee_pct=10.00, issuer_fee_pct=5.00.

-- Резолвер тарифа по запросу инвестиций (вызывается сервером при публикации/смене ask)
CREATE OR REPLACE FUNCTION billing.resolve_founder_plan(p_ask NUMERIC, p_at TIMESTAMPTZ DEFAULT now())
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT id FROM billing.subscription_plans
    WHERE audience = 'founder'
      AND valid_from <= p_at AND (valid_to IS NULL OR valid_to > p_at)
      AND (ask_limit IS NULL OR p_ask <= ask_limit)
    ORDER BY ask_limit NULLS LAST, version DESC LIMIT 1;
$$;
-- Constraint triggers запрещают пересечение периодов действия версий одного code
-- и одновременные активные fee schedule с одинаковым code.

ALTER TABLE lab.projects
    ADD CONSTRAINT projects_required_plan_fk
    FOREIGN KEY (required_plan_id) REFERENCES billing.subscription_plans(id);
ALTER TABLE investments.investment_agreements
    ADD CONSTRAINT investment_agreements_fee_schedule_fk
    FOREIGN KEY (fee_schedule_id) REFERENCES billing.fee_schedules(id);
```

### 11.2. Подписки

```sql
CREATE TABLE billing.subscriptions (
    id                  UUID PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES identity.users(id),
    plan_id             UUID NOT NULL REFERENCES billing.subscription_plans(id),
    project_id          UUID REFERENCES lab.projects(id),
                        -- founder: подписка на размещение КОНКРЕТНОГО проекта (обязателен);
                        -- investor: NULL (подписка на аккаунт)
    price_snapshot      NUMERIC(14,2) NOT NULL CHECK (price_snapshot >= 0),
    currency_snapshot   CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency_snapshot = 'RUB'),
    terms_version       TEXT NOT NULL,
    custom_price        NUMERIC(14,2) CHECK (custom_price IS NULL OR custom_price > 0),
    custom_price_set_by UUID REFERENCES identity.users(id),
    custom_price_approved_by UUID REFERENCES identity.users(id),
    status              TEXT NOT NULL DEFAULT 'pending_payment' CHECK (status IN
                        ('pending_payment','active','past_due','canceled','expired')),
    current_period_end  TIMESTAMPTZ,
    grace_until         TIMESTAMPTZ,         -- листинг снимается после grace (→ suspended_billing)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    canceled_at         TIMESTAMPTZ,
    CHECK (custom_price IS NULL OR
          (custom_price_set_by IS NOT NULL AND custom_price_approved_by IS NOT NULL
           AND custom_price_set_by <> custom_price_approved_by))
);
CREATE INDEX subscriptions_user ON billing.subscriptions (user_id, status);
CREATE INDEX subscriptions_project ON billing.subscriptions (project_id) WHERE status = 'active';
-- Один активный founder-тариф на проект; одна активная подписка инвестора на аккаунт:
CREATE UNIQUE INDEX subscriptions_one_active_per_project
    ON billing.subscriptions (project_id) WHERE status IN ('pending_payment','active','past_due');
CREATE UNIQUE INDEX subscriptions_one_investor_active
    ON billing.subscriptions (user_id) WHERE status IN ('pending_payment','active','past_due')
    AND project_id IS NULL;
-- Инвариант сервисного слоя (тест CI): projects.listing_status='listed' возможен только
-- при status='active', plan_id=projects.required_plan_id и владельце проекта.
-- Смена ask сверх лимита → требование апгрейда до republication.
-- Деферред constraint trigger M008 проверяет: founder plan ↔ project_id NOT NULL;
-- investor plan ↔ project_id IS NULL; snapshot соответствует plan/custom approval.

CREATE TABLE billing.commission_accruals (
    id                  UUID PRIMARY KEY,
    agreement_id        UUID NOT NULL UNIQUE REFERENCES investments.investment_agreements(id),
    trigger_tranche_id  UUID NOT NULL UNIQUE REFERENCES investments.investment_tranches(id),
    fee_schedule_id     UUID NOT NULL REFERENCES billing.fee_schedules(id),
    base_amount         NUMERIC(14,2) NOT NULL CHECK (base_amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    investor_fee_pct    NUMERIC(5,2) NOT NULL,
    issuer_fee_pct      NUMERIC(5,2) NOT NULL,
    investor_fee_amount NUMERIC(14,2) GENERATED ALWAYS AS
                        (round(base_amount * investor_fee_pct / 100, 2)) STORED,
    issuer_fee_amount   NUMERIC(14,2) GENERATED ALWAYS AS
                        (round(base_amount * issuer_fee_pct / 100, 2)) STORED,
    status              TEXT NOT NULL DEFAULT 'accrued' CHECK (status IN
                        ('accrued','invoiced','partially_paid','paid','disputed','adjusted')),
    accrued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (investor_fee_pct >= 0 AND investor_fee_pct <= 100),
    CHECK (issuer_fee_pct >= 0 AND issuer_fee_pct <= 100)
);
-- Вставка разрешена только confirm_first_tranche(): base_amount=agreement.contract_amount,
-- snapshot процентов = fee_schedule договора, trigger_tranche.tranche_no=1/status='confirmed'.
-- UPDATE денежных полей запрещён; корректировки — компенсирующие записи в журнале/инвойсе.

CREATE TABLE billing.invoices (
    id                  UUID PRIMARY KEY,
    subscription_id     UUID REFERENCES billing.subscriptions(id),
    accrual_id          UUID REFERENCES billing.commission_accruals(id),
    payer_role          TEXT NOT NULL CHECK (payer_role IN ('account','investor','issuer')),
    payer_user_id       UUID REFERENCES identity.users(id),
    payer_entity_id     UUID REFERENCES kyc.business_entities(id),
    number              TEXT NOT NULL UNIQUE,
    amount_due          NUMERIC(14,2) NOT NULL CHECK (amount_due > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    tax_jsonb           JSONB NOT NULL DEFAULT '{}',
    requisites_snapshot JSONB NOT NULL,
    status              TEXT NOT NULL DEFAULT 'issued' CHECK (status IN
                        ('issued','partially_paid','paid','overdue','void','adjusted')),
    pdf_s3_key          TEXT NOT NULL,
    pdf_wrapped_dek     BYTEA NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    due_at              TIMESTAMPTZ NOT NULL,
    CHECK (num_nonnulls(subscription_id, accrual_id) = 1),
    CHECK (num_nonnulls(payer_user_id, payer_entity_id) = 1),
    CHECK (due_at >= issued_at),
    UNIQUE (accrual_id, payer_role)
);

CREATE TABLE billing.payments (
    id              UUID PRIMARY KEY,
    invoice_id      UUID NOT NULL REFERENCES billing.invoices(id),
    user_id         UUID REFERENCES identity.users(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    refunded_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0 AND refunded_amount <= amount),
    currency        CHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency = 'RUB'),
    provider        TEXT NOT NULL,
    provider_ref    TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','authorized','succeeded','failed','partially_refunded','refunded','chargeback')),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash    BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_ref)
);
CREATE INDEX payments_invoice ON billing.payments (invoice_id, status);
```

Сумма успешных `payments` минус возвраты определяет оплату invoice; статус invoice и accrual обновляется одной серверной командой с outbox. Инвестиционные транши не имеют FK на `billing.payments`.

---

## 12. audit — события, outbox, ключи, флаги, AI-графы

```sql
CREATE SCHEMA audit;

CREATE TABLE audit.event_type_registry (
    verb            TEXT PRIMARY KEY,
    description     TEXT,
    actor_roles_allowed TEXT[] NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE audit.events (                                    -- APPEND-ONLY
    id              UUID NOT NULL,
    ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
    verb            TEXT NOT NULL REFERENCES audit.event_type_registry(verb),
    actor_id        UUID,
    actor_role      TEXT,
    subject_type    TEXT,
    subject_id      UUID,
    context_jsonb   JSONB NOT NULL DEFAULT '{}',
    trace_id        TEXT,
    prev_hash       BYTEA,
    row_hash        BYTEA,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
SELECT partman.create_parent(
    p_parent_table := 'audit.events',
    p_control      := 'ts',
    p_interval     := '1 month',
    p_type         := 'range'
);

CREATE OR REPLACE FUNCTION audit.app_emit_event(
    p_verb TEXT, p_actor_id UUID, p_actor_role TEXT,
    p_subject_type TEXT, p_subject_id UUID,
    p_context JSONB, p_trace_id TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, audit, public AS $$
DECLARE v_id UUID; v_prev BYTEA; v_hash BYTEA; v_ts TIMESTAMPTZ := clock_timestamp();
BEGIN
    -- Одна последовательность hash-chain; исключает ветвление при конкурентных INSERT.
    PERFORM pg_advisory_xact_lock(hashtext('audit.events.hash_chain'));
    IF NOT EXISTS (
        SELECT 1 FROM audit.event_type_registry r
        WHERE r.verb = p_verb
          AND p_actor_role = ANY(r.actor_roles_allowed)
    ) THEN
        RAISE EXCEPTION 'actor role % is not allowed for %', p_actor_role, p_verb;
    END IF;
    SELECT row_hash INTO v_prev FROM audit.events
        ORDER BY ts DESC, id DESC LIMIT 1;
    v_id := gen_random_uuid();  -- в проде: uuidv7()
    v_hash := digest(convert_to(concat(
        encode(coalesce(v_prev, '\x00'::bytea), 'hex'), '|', v_id, '|', v_ts, '|', p_verb, '|',
        coalesce(p_actor_id::text,''), '|', coalesce(p_actor_role,''), '|',
        coalesce(p_subject_type,''), '|', coalesce(p_subject_id::text,''), '|',
        coalesce(p_context,'{}'::jsonb)::text, '|', coalesce(p_trace_id,'')
    ), 'UTF8'), 'sha256');
    INSERT INTO audit.events (id, ts, verb, actor_id, actor_role, subject_type,
                              subject_id, context_jsonb, trace_id, prev_hash, row_hash)
    VALUES (v_id, v_ts, p_verb, p_actor_id, p_actor_role, p_subject_type,
            p_subject_id, coalesce(p_context,'{}'::jsonb), p_trace_id, v_prev, v_hash);
    RETURN v_id;
END $$;

CREATE OR REPLACE FUNCTION audit.forbid_event_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit.events is append-only'; END $$;
CREATE TRIGGER events_no_update BEFORE UPDATE OR DELETE ON audit.events
    FOR EACH ROW EXECUTE FUNCTION audit.forbid_event_mutation();

CREATE TABLE audit.outbox_events (
    id              UUID PRIMARY KEY,
    aggregate_type  TEXT NOT NULL,
    aggregate_id    UUID NOT NULL,
    event_type      TEXT NOT NULL,
    payload_jsonb   JSONB NOT NULL,
    nats_subject    TEXT NOT NULL,
    schema_version  INTEGER NOT NULL DEFAULT 1,
    aggregate_version BIGINT NOT NULL,
    message_key     TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at       TIMESTAMPTZ,
    last_error      TEXT,
    published_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (aggregate_type, aggregate_id, aggregate_version, event_type)
);
CREATE INDEX outbox_unpublished ON audit.outbox_events (next_attempt_at, created_at)
    WHERE published_at IS NULL;
-- Publisher забирает строки FOR UPDATE SKIP LOCKED, публикует event_id как Nats-Msg-Id,
-- повторяет с backoff и после лимита переносит в операционный DLQ. Любая внешне
-- наблюдаемая доменная мутация и её outbox INSERT коммитятся одной транзакцией;
-- CI architecture-test запрещает прямой repository commit без зарегистрированного event.

CREATE TABLE audit.consumed_events (
    consumer        TEXT NOT NULL,
    event_id        UUID NOT NULL,
    consumed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);

CREATE TABLE audit.encryption_keys_registry (
    id              UUID PRIMARY KEY,
    domain          TEXT NOT NULL CHECK (domain IN
                    ('kyc_documents','kyb_documents','passport_sensitive',
                     'investment_documents','nominal_account_evidence',
                     'billing_documents','search_index')),
                    -- KEK-домены Capital добавляет отдельно
    kms_key_id      TEXT NOT NULL,
    wrapped_dek     BYTEA,
    rotated_from_id UUID REFERENCES audit.encryption_keys_registry(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit.feature_flags (
    key             TEXT PRIMARY KEY,
    enabled         BOOLEAN NOT NULL DEFAULT false,
    rules_jsonb     JSONB NOT NULL DEFAULT '{}',
    updated_by      UUID REFERENCES identity.users(id),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit.agent_runs (
    id              UUID PRIMARY KEY,
    graph_name      TEXT NOT NULL,
    project_id      UUID REFERENCES lab.projects(id),
    user_id         UUID REFERENCES identity.users(id),
    status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN
                    ('running','succeeded','failed','cancelled')),
    model_id        UUID REFERENCES scoring.score_models(id),
    langfuse_trace_id TEXT,
    cost_usd        NUMERIC(10,4),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE TABLE audit.node_checkpoints (
    id              UUID PRIMARY KEY,
    run_id          UUID NOT NULL REFERENCES audit.agent_runs(id),
    node_name       TEXT NOT NULL,
    state_jsonb     JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 13. integration — швы для Capital и Шоу

```sql
CREATE SCHEMA integration;

CREATE TABLE integration.service_accounts (
    id              UUID PRIMARY KEY,
    client_id       TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,                             -- 'unicorn-capital','media-gateway'
    client_secret_hash TEXT NOT NULL,                          -- Argon2id; ротация 90 дней
    mtls_cert_fingerprint TEXT NOT NULL,
    scopes          TEXT[] NOT NULL DEFAULT '{}',
                    -- 'graduates:read','passport:read','listing:create','deals:read',
                    -- 'show:read','webhooks:manage','seasons:read'
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
    created_by      UUID NOT NULL REFERENCES identity.users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at      TIMESTAMPTZ
);

CREATE TABLE integration.webhook_endpoints (
    id              UUID PRIMARY KEY,
    service_account_id UUID NOT NULL REFERENCES integration.service_accounts(id),
    url             TEXT NOT NULL,
    subscribed_verbs TEXT[] NOT NULL,
    secret_ciphertext BYTEA NOT NULL,                          -- исходящий HMAC-secret, envelope encryption
    secret_kms_key_id TEXT NOT NULL,
    secret_fingerprint BYTEA NOT NULL,                         -- поиск/аудит без раскрытия секрета
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE integration.webhook_deliveries (
    id              UUID PRIMARY KEY,
    endpoint_id     UUID NOT NULL REFERENCES integration.webhook_endpoints(id),
    event_id        UUID NOT NULL REFERENCES audit.outbox_events(id),
    status          TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','delivered','failed','exhausted')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    response_code   INTEGER,
    next_retry_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (endpoint_id, event_id)
);

CREATE TABLE integration.external_refs (
    id              UUID PRIMARY KEY,
    local_type      TEXT NOT NULL,
    local_id        UUID NOT NULL,
    remote_system   TEXT NOT NULL,                             -- 'unicorn-capital','media-hub'
    remote_type     TEXT NOT NULL,                             -- 'listing','episode'
    remote_id       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (remote_system, remote_type, remote_id),
    UNIQUE (local_type, local_id, remote_system, remote_type)
);
```

---

## 14. Событийная модель Launch (verbs для `event_type_registry`)

| verb | actor_roles | NATS subject | Консьюмер |
|---|---|---|---|
| `lab.project.submitted` | founder | `lab.project.submitted` | аналитика, Шоу (счётчик) |
| `lab.project.scored` | system | `lab.project.scored` | Capital (предпросмотр) |
| `lab.project.status_changed` | system/admin | `lab.project.status_changed` | обе платформы |
| `lab.project.graduated` | system | `lab.project.graduated` | **Capital → листинг** |
| `lab.listing.published` | founder/system | `lab.listing.published` | аналитика, Шоу |
| `lab.listing.unpublished` | founder/admin/system | `lab.listing.unpublished` | аналитика |
| `lab.irs.recalculated` | system | `lab.irs.recalculated` | Capital, TOP-100 |
| `investment.offer.published` | admin/system | `investment.offer.published` | каталог, аналитика |
| `investment.agreement.signed` | system | `investment.agreement.signed` | comms, реестр договоров |
| `investment.first_tranche.confirmed` | system | `investment.first_tranche.confirmed` | billing, отчётность |
| `investment.agreement.effective` | system | `investment.agreement.effective` | Capital (агрегаты), аналитика |
| `billing.commission.accrued` | system | `billing.commission.accrued` | invoices, comms, аналитика |
| `lab.subscription.activated` / `lab.subscription.past_due` | system | — (внутренний) | comms, jobs (снятие листинга) |
| `lab.payment.succeeded` | system | `lab.payment.succeeded` | аналитика |
| `lab.expert.review_submitted` | expert | — (внутренний) | — |
| `lab.consensus.decided` | admin | `lab.consensus.decided` | аналитика |
| `lab.season.opened` / `lab.season.closed` | admin | `lab.season.*` | обе |
| `lab.rating.published` | admin | `lab.rating.published` | Шоу, web-public |
| `lab.consent.publication_granted` | founder | `lab.consent.publication_granted` | **Шоу — лицензия** |
| `lab.consent.publication_revoked` | founder | `lab.consent.publication_revoked` | **Шоу — удаление ≤15 мин** |
| `security.new_login` / `security.mfa_changed` | system | — | comms (sms+email) |

Зарезервированные префиксы (не регистрируются до запуска платформ): `capital.*`, `auction.*`, `show.*`.

---

## 15. RLS-политики Launch

```sql
-- Контекст: SET LOCAL app.current_user_id = '<uuid>';
--           SET LOCAL app.current_roles  = 'founder,investor';
-- Значения выставляет только middleware после проверки access token; подключения клиентов к БД нет.

-- identity.users: себя; admin/organizer — всех
CREATE POLICY users_select ON identity.users FOR SELECT USING (
    id = current_setting('app.current_user_id', true)::uuid
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

-- lab.projects: владелец + admin/organizer — полностью;
-- эксперт — назначенные; инвестор — только листинги и только с активной подпиской
CREATE POLICY projects_select ON lab.projects FOR SELECT USING (
    'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR EXISTS (SELECT 1 FROM lab.founders_projects fp
               WHERE fp.project_id = projects.id
                  AND fp.user_id = current_setting('app.current_user_id', true)::uuid)
    OR ('expert' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
        AND EXISTS (SELECT 1 FROM experts.expert_assignments ea
                    WHERE ea.project_id = projects.id
                      AND ea.expert_id = current_setting('app.current_user_id', true)::uuid))
    OR ('investor' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
        AND projects.listing_status = 'listed'
        AND EXISTS (SELECT 1 FROM billing.subscriptions s
                    JOIN billing.subscription_plans sp ON sp.id = s.plan_id
                    WHERE s.user_id = current_setting('app.current_user_id', true)::uuid
                      AND sp.audience = 'investor'
                      AND s.status = 'active')));
-- Анонимный/неоплативший доступ — только allowlist тизера. Для security_invoker view
-- app_public_read получает column-level GRANT на перечисленные колонки и отдельную policy;
-- GRANT SELECT на всю lab.projects запрещён.
CREATE POLICY projects_public_teaser ON lab.projects FOR SELECT TO app_public_read USING (
    listing_status = 'listed' AND deleted_at IS NULL);
GRANT SELECT (id, taxonomy_id, title, tagline, stage, geo_country,
              investment_ask, ask_currency, listed_at)
    ON lab.projects TO app_public_read;
GRANT SELECT ON lab.v_public_catalog TO app_public_read;

-- experts.expert_reviews: эксперт — только своё назначение
CREATE POLICY reviews_expert_own ON experts.expert_reviews FOR ALL USING (
    EXISTS (SELECT 1 FROM experts.expert_assignments ea
            WHERE ea.id = expert_reviews.assignment_id
              AND ea.expert_id = current_setting('app.current_user_id', true)::uuid)
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

-- scoring.*: владелец проекта; инвестор с активной подпиской — teaser/full активного листинга;
-- dataroom выдаётся только отдельным regulated grant и не покрывается этой policy.
CREATE POLICY passports_read ON scoring.investment_passports FOR SELECT USING (
    'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR EXISTS (SELECT 1 FROM lab.founders_projects fp
               WHERE fp.project_id = investment_passports.project_id
                  AND fp.user_id = current_setting('app.current_user_id', true)::uuid)
    OR ('investor' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
        AND disclosure_tier IN ('teaser','full')
        AND EXISTS (SELECT 1 FROM lab.projects p
                    JOIN billing.subscriptions s
                      ON s.user_id = current_setting('app.current_user_id', true)::uuid
                     AND s.project_id IS NULL AND s.status = 'active'
                    JOIN billing.subscription_plans sp ON sp.id = s.plan_id AND sp.audience = 'investor'
                    WHERE p.id = investment_passports.project_id
                      AND p.listing_status = 'listed')));

-- investments: договор и транши видят инвестор, ЛПИ и admin/organizer.
CREATE POLICY investment_agreements_parties ON investments.investment_agreements FOR SELECT USING (
    investor_id = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (
        SELECT 1 FROM investments.investment_offers io
        JOIN kyc.entity_members em ON em.entity_id = io.issuer_entity_id
        WHERE io.id = investment_agreements.offer_id
          AND em.user_id = current_setting('app.current_user_id', true)::uuid
          AND em.member_role IN ('signatory','representative'))
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

CREATE POLICY investment_tranches_parties ON investments.investment_tranches FOR SELECT USING (
    EXISTS (SELECT 1 FROM investments.investment_agreements ia
            WHERE ia.id = investment_tranches.agreement_id
              AND (ia.investor_id = current_setting('app.current_user_id', true)::uuid
                   OR EXISTS (SELECT 1 FROM investments.investment_offers io
                              JOIN kyc.entity_members em ON em.entity_id = io.issuer_entity_id
                              WHERE io.id = ia.offer_id
                                AND em.user_id = current_setting('app.current_user_id', true)::uuid)))
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

-- billing: пользователь видит свои подписки; начисление/invoice — соответствующая сторона.
CREATE POLICY subscriptions_own ON billing.subscriptions FOR SELECT USING (
    user_id = current_setting('app.current_user_id', true)::uuid
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

CREATE POLICY invoices_party ON billing.invoices FOR SELECT USING (
    payer_user_id = current_setting('app.current_user_id', true)::uuid
    OR EXISTS (SELECT 1 FROM kyc.entity_members em
               WHERE em.entity_id = invoices.payer_entity_id
                 AND em.user_id = current_setting('app.current_user_id', true)::uuid)
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

-- Сервисные write-policy задаются отдельно, например:
CREATE POLICY investment_service_write ON investments.investment_tranches
    FOR ALL TO app_investments USING (true) WITH CHECK (true);
CREATE POLICY billing_service_write ON billing.payments
    FOR ALL TO app_billing USING (true) WITH CHECK (true);
-- app_backend не получает прямого UPDATE денежных статусов; вызывает ограниченные команды.

-- comms.user_devices / notifications: только владелец
CREATE POLICY devices_own ON comms.user_devices FOR ALL USING (
    user_id = current_setting('app.current_user_id', true)::uuid);
CREATE POLICY notifications_own ON comms.notifications FOR SELECT USING (
    user_id = current_setting('app.current_user_id', true)::uuid);

-- identity.consents / publication_consents: владелец + admin
CREATE POLICY consents_own ON identity.consents FOR SELECT USING (
    user_id = current_setting('app.current_user_id', true)::uuid
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));

-- audit.events: чтение own; записи ролям нет (только app_emit_event)
CREATE POLICY events_read_own ON audit.events FOR SELECT USING (
    actor_id = current_setting('app.current_user_id', true)::uuid
    OR 'admin' = ANY(string_to_array(current_setting('app.current_roles', true), ','))
    OR 'organizer' = ANY(string_to_array(current_setting('app.current_roles', true), ',')));
```

Тесты на обход RLS — обязательный гейт CI: founder читает чужой проект, инвестор без подписки — full passport, инвестор — нелистинговый проект, эксперт — неназначенный, сторона — чужой договор/транш/invoice, `app_backend` напрямую подтверждает транш или создаёт начисление. Отдельный тест перечисляет все таблицы с ПДн/деньгами и падает, если для таблицы не включены `ENABLE/FORCE RLS` либо отсутствует manifest policy.

---

## 16. Миграционный план Launch

> **План выполнен и давно перерос эту таблицу.** Ниже — M000–M011, как их
> задумывали в августе. Фактически миграций 71, последняя M070: M012–M070
> добавили экспертизу, поддержку, избранное, LLM-скоринг, архив журнала и
> многое другое. Актуальный список — `database/migrations/`.


| Миграция | Содержание |
|---|---|
| M000 baseline | Расширения, 11 схем, роли БД без BYPASSRLS, базовые GRANT/REVOKE, partman |
| M001 audit-core | registry, events/партиции, `app_emit_event()`, outbox/consumed и append-only триггеры — до доменных команд |
| M002 identity | users, roles, auth identities, consents/events/templates, publication consents, investor profiles + RLS |
| M003 kyc | kyc_verifications, business_entities, kyb_verifications, entity_members + RLS |
| M004 lab | taxonomy, projects, safe public view, founders, версии, материалы, parses, duplicates + FTS + RLS |
| M005 investments | offers, agreements, tranches, nominal-account transactions; regulated limits/state-machine + RLS |
| M006 scoring | models, passports (HNSW/GIN), facts, scores, IRS, readiness, roadmaps + RLS |
| M007 experts+seasons | 5 таблиц экспертизы, seasons, golden_tickets, versioned rating publication |
| M008 comms | devices, templates, notifications, preferences + RLS + сиды шаблонов |
| M009 billing | versioned plans + fee schedules, subscriptions, accruals, invoices, payments, deferred FK/constraint triggers + RLS |
| M010 audit-extra+integration | keys, flags, agent runs; service accounts, webhook endpoints/deliveries, external refs + RLS |
| M011 seeds | сезон 1, таксономия, **тарифы/fee schedule §16.1**, уведомления, Правила/договоры v1, consent templates, event registry, фичефлаги |

Каждая миграция проходит `up` на чистом PostgreSQL 16 и upgrade с предыдущего релиза. Down-скрипт обязателен только для безопасно обратимых изменений; production исправляется forward-only миграцией. Линтер expand/contract, проверка FK/RLS/GRANT, конкурентные тесты `confirm_first_tranche` и повтор банковского webhook обязательны в CI; dev — только синтетика, staging — анонимизированный дамп.

### 16.1. Сид тарифов и fee schedule

```sql
INSERT INTO billing.subscription_plans
    (id, code, version, audience, name, ask_limit, price, individual_pricing, valid_from) VALUES
 (uuid_generate_v7(),'founder_t1',1,'founder','Старт — запрос до 1 млн ₽',        1000000,     4990,   false,'2026-08-09T00:00:00Z'),
 (uuid_generate_v7(),'founder_t2',1,'founder','Рост — запрос до 10 млн ₽',        10000000,    9990,   false,'2026-08-09T00:00:00Z'),
 (uuid_generate_v7(),'founder_t3',1,'founder','Масштаб — запрос до 100 млн ₽',   100000000,   29990,  false,'2026-08-09T00:00:00Z'),
 (uuid_generate_v7(),'founder_t4',1,'founder','Крупный — запрос до 1 млрд ₽',    1000000000,  199990, false,'2026-08-09T00:00:00Z'),
 (uuid_generate_v7(),'founder_t5',1,'founder','Стратегический — свыше 1 млрд ₽', NULL,        NULL,   true, '2026-08-09T00:00:00Z'),
 (uuid_generate_v7(),'investor_membership',1,'investor','Подписка инвестора',    NULL,        100000, false,'2026-08-09T00:00:00Z');

INSERT INTO billing.fee_schedules
    (id, code, version, investor_fee_pct, issuer_fee_pct, rules_version, valid_from)
VALUES
    (uuid_generate_v7(),'operator_success_fee',1,10.00,5.00,'platform_rules_v1','2026-08-09T00:00:00Z');
```

---

## 17. Чек-лист интеграции следующих платформ

**Unicorn Capital (путь A — модули в том же core):**
1. Новые схемы `capital`, `auctions`, `dataroom`, `deal` добавляются рядом, но не получают прямых write-доступов к `investments`/`billing`.
2. Консьюмер `lab.project.graduated` создаёт Capital listing и `integration.external_refs`; `projects.status='graduated'` не смешивается с Launch `listing_status`.
3. История доступна через агрегаты `investments.investment_agreements` + `billing.commission_accruals` в Integration API и события `investment.agreement.effective`/`billing.commission.accrued`.
4. Для каждой новой инвестиции назначается ровно один оператор. Уже effective договоры Launch остаются в его реестре; Capital не создаёт второе начисление на ту же инвестицию.

**Capital как отдельный сервис (путь B):**
1. Строка в `integration.service_accounts` (scopes: `graduates:read`, `passport:read`, `listing:create`, `deals:read`) + mTLS.
2. Подписка на разрешённые subjects стрима `LAUNCH` (`lab.*`, агрегаты `investment.*`/`billing.*`) или webhook; OIDC-клиент на `id.unicorn.vc`; маппинг — `integration.external_refs`.

**Медиаконтур Шоу:**
1. `integration.service_accounts` (scope `show:read`) + консьюмер `lab.consent.*`.
2. Публикация — только при активном `publication_consents`; отзыв → удаление проекции ≤ 15 мин.
3. pubDb — отдельный кластер; Media Gateway читает только через Integration API `public-profile`.
