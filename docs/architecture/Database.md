# DATABASE.md — структура базы данных экосистемы UNICORN

> **Статус после 2.1-W05 (29.10.2026):** схемы `investments`, `experts`, `scoring`, `seasons` и таблицы `billing`, кроме списка стран обслуживания, а также сущности медиаконтура и согласий на публичный контур удалены из кода и базы (миграция M150). Документ описывает систему до этого задания; разделы о перечисленном к текущей системе не относятся и требуют новой проработки.

> **Версия:** 1.0 · **Дата:** 09.08.2026 · **СУБД:** PostgreSQL 16+
> **Основание:** `Rules_arc.md` §7 (45 сущностей, ревизия совета) + новые домены по требованию заказчика: **аукцион** (§6), **KYB** (§5), **SMS/push-уведомления и устройства** (§7).
> Связанный документ: `docs/architecture/Architect.md`. Детальный DDL базовых 45 сущностей — в `Rules_arc.md` §7.2 (здесь не дублируется); ниже — полная карта сущностей и **полный DDL всех новых/изменённых таблиц**.

---

## 1. Принципы

1. **Одна OLTP-база** (закрытый контур) + физически отдельный кластер `pubDb` (публичная проекция). Расширения: `pgcrypto`, `pgvector` (HNSW, vector(1536)), `pg_partman`, `citext`.
2. **Идентификаторы — UUIDv7** (временнáя сортируемость, keyset-пагинация).
3. **Деньги** — всегда пара `amount NUMERIC(14,2) + currency CHAR(3)` (мультивалютность с первого дня); никогда не FLOAT.
4. **RLS — основной механизм авторизации** на уровне строк + явные проверки в сервисном слое. Session-переменные `app.current_user_id`, `app.current_roles` (CSV), `SET LOCAL` на транзакцию (совместимо с PgBouncer transaction-mode). Deny by default; у бэкенд-роли НЕТ `BYPASSRLS`.
5. **Append-only журнал событий** с хеш-цепочкой; запись только через `SECURITY DEFINER app_emit_event()`; UPDATE/DELETE запрещены правами и триггером.
6. **Transactional Outbox** — доменная запись и событие в одной транзакции.
7. **Идемпотентность** — `idempotency_key` UNIQUE на платежах, ставках, интересах.
8. **Soft delete** (`deleted_at`) на пользовательских сущностях; частичные UQ с `WHERE deleted_at IS NULL`.
9. **Шифрование:** envelope encryption AES-256-GCM — KMS master key → KEK per домен → per-record DEK, `wrapped_dek` рядом с записью (`encryption_keys_registry`). Домены KEK: `kyc_documents`, `kyb_documents`, `capital_financial`, `passport_sensitive`, `auction_sealed`, `search_index` (blind index HMAC-SHA256). Полевое шифрование: KYC/KYB-пакеты, cap table, finance/legal-факты паспорта, sealed-ставки, резервная цена аукциона. Под TDE (осознанно): суммы (нужны агрегаты), email/телефон (login+UQ).
10. **Миграции expand/contract:** EXPAND (nullable + dual write) → MIGRATE (backfill батчами) → CONTRACT (DROP через ≥30 дней без читателей). Каждая миграция — с down-скриптом.

---

## 2. Карта сущностей (52 таблицы: 45 из Rules_arc + 7 новых)

### 2.1. Identity, KYC/KYB, согласия
| Таблица | Назначение | Ключевое |
|---|---|---|
| `users` | Аккаунты | `email` CITEXT (частичный UQ), `phone` UQ, `password_hash` NULL (соц-вход), `primary_role` CHECK (founder/investor/expert/corporate/organizer/admin/showrunner), `status`, `locale`, `currency_pref`, `home_contour` (ru/cis/hub), soft delete |
| `user_roles` | 1:N ролей | `granted_by`, `revoked_at`; частичный UQ (user_id, role) WHERE revoked |
| `auth_identities` | Способы входа | provider (email/phone/telegram/google/vk), provider_uid, verified_at |
| `kyc_verifications` | История верификаций 1:N | kind (identity/investor_status/accredited), status, provider, evidence_ref, reviewed_by — **расширена, см. §5.2** |
| **`business_entities`** | **НОВАЯ — юрлица (KYB)** | ИНН/ОГРН, юрисдикция, статус реестра — см. §5.1 |
| **`kyb_verifications`** | **НОВАЯ — проверки юрлиц** | registry_check / beneficial_owners / accreditation — см. §5.1 |
| `consents` | Согласия ПДн/оферта/маркетинг | kind, version, ip_hash, revoked_at (+ `consent_templates`, `consent_cascade_jobs` для каскада отзыва) |
| `nda_acceptances` | NDA-акцепты | полиморфно (project/dataroom_section), document_version |

### 2.2. Проекты и материалы
`project_taxonomy` (дерево), `projects` (статусная машина draft→submitted→ai_review→expert_review→bootcamp→finalist→listed/rejected/archived, season_id, current_version_id), `founders_projects` (N:M, equity_pct), `project_versions` (ресабмит по сезонам, snapshot_jsonb), `project_materials` (UQ project_id+type+version), `project_material_parses` (AI-парсинг, extracted_jsonb, model_version), `project_duplicates` (perceptual_hash/embedding, антифрод).

### 2.3. Паспорт и скоринг
`score_models` (версии моделей, is_active), `investment_passports` (UQ project_id+version, jsonb_data, embedding vector(1536) HNSW, disclosure_tier teaser/full/dataroom), `passport_facts` (8 категорий, source_ref, confidence; finance/legal — полевое шифрование), `scores` (9 осей, value 0–100, confidence_low/high, explanation NOT NULL), `irs_scores` (история: value, previous_value, delta), `readiness_map` (13 измерений, UQ project_id+dimension), `roadmaps` + `roadmap_steps`.

### 2.4. Экспертиза
`experts`, `expert_assignments` (SLA 7 дней), `expert_reviews` (rubric_scores_jsonb с CHECK 6 ключей), `expert_conflict_declarations`, `review_consensus` (discrepancy → third reviewer).

### 2.5. Capital: листинги, окна, интересы
`listings` (round_type safe/convertible_loan/equity, round_status discovery→due_diligence→investor_competition→allocation→round_closing→closed/withdrawn, **version — optimistic locking**), `listing_windows` (окно 21 день, продление = новая строка, extended_from_id), `round_status_history`, `investor_profiles` (mandate_jsonb + mandate_embedding), `investor_membership_tiers` (member/trusted/black/founding, один активный tier), `investor_ratings`, `interests` (stage viewed/requested/dd/committed/declined; частичный UQ на committed), `matches` (probability NULL до валидации модели), `golden_tickets` (лимит 1–2/сезон CHECK-триггером).

### 2.6. Аукцион — НОВЫЙ ДОМЕН (полный DDL в §6)
**`auctions`** (1 активный на листинг, формат, четырёхглазое включение, антиснайпинг, шифрованная резервная цена) · **`auction_bids`** (append-only ставки, идемпотентность) · **`auction_extensions`** — нет, продления в `events` + поля аукциона.

### 2.7. Data Room
`dataroom_sections` (9 CHECK-разделов), `dataroom_documents` (версии, watermark_policy), `access_grants` (полиморфные, уровни teaser/full/dataroom, частичный UQ активного гранта), `document_views` (водяной знак сессии, ip_hash — журнал виден основателю), `dataroom_qa`.

### 2.8. Сделка
`allocations` (1 активная на листинг, статусная машина proposed→founder_review→committee_review→finalized), `allocation_offers`, `deal_documents` (unicorn_terms/nda/term_sheet), `deal_document_versions` (шифрованные, signed_by jsonb — MVP: намерение).

### 2.9. Биллинг
`subscription_plans`, `subscriptions` (trialing/active/past_due/canceled), `payments` (idempotency_key UQ, provider_ref), `invoices`.

### 2.10. Сезоны, события, уведомления
`seasons` (номер, даты, caps, funnel_config_jsonb), `event_type_registry` (whitelist verb'ов + actor_roles_allowed), **`events`** (append-only, PARTITION BY RANGE (ts) помесячно, PK(id,ts), prev_hash/row_hash SHA-256, trace_id), `listing_activity_counters` (FOMO, инкремент триггером), `outbox_events`, `consumed_events` (дедуп консьюмеров), `mv_listing_funnel_daily` (materialized view).

### 2.11. Уведомления — расширено (полный DDL в §7)
`notifications` (**channel расширен: telegram/email/inapp + push + sms**, provider, dedup_key), `notification_preferences` (per user × channel × topic, quiet hours), **`notification_templates`** (НОВАЯ — версионированные шаблоны), **`user_devices`** (НОВАЯ — push-токены iOS/Android/Web-PWA).

### 2.12. Публичный контур (в `pubDb`, отдельный кластер)
`public_track_consents` (scope episode_selection/bootcamp/final_live, disclosed_fields), `show_episodes`, `show_appearances` (consent_id FK, anonymized). Проекции обезличенные (hash id), удаление при отзыве ≤ 15 мин.

### 2.13. Технические
`encryption_keys_registry` (domain, kms_key_id, wrapped_dek, rotated_from_id), `agent_runs` + `node_checkpoints` (AI-графы), `ai_budgets`, `ai_decision_log`, `feature_flags`.

---

## 3. RLS-политики

Базовые 7 (из Rules_arc §7.3): `projects` (основатель+admin/organizer; эксперт — назначенные; **инвестор — только через VIEW `investor_visible_listings`**), `expert_reviews`, `listings` (инвестор — при активном гранте), `dataroom_documents`, `document_views`, `access_grants` (запись только admin/organizer), `events` (чтение own; запись только `app_emit_event`).

**Новые политики** — DDL в §6.4 (аукцион) и §7.4 (устройства): участник видит аукцион только при активном гранте на листинг; свои ставки — полностью, чужие — только через VIEW агрегатов; `user_devices` — только владелец и notification-сервис.

---

## 4. Событийная модель (journal verbs)

Базовые: `project.submitted`, `project.scored`, `listing.window_opened`, `interest.committed`, `dataroom.document_viewed`, `allocation.finalized`, `consent.revoked`…

**Новые verbs аукциона** (добавить в `event_type_registry`):

| verb | actor_roles | payload (context_jsonb) |
|---|---|---|
| `auction.created` | admin | auction_id, listing_id, format |
| `auction.enabled` | admin (2-й, approver) | auction_id, starts_at, ends_at |
| `auction.started` | system | auction_id |
| `auction.bid_placed` | investor | auction_id, bid_id, amount **(скрывается в публичных проекциях для sealed)** |
| `auction.outbid` | system | auction_id, outbid_bid_id (для push проигравшему) |
| `auction.extended` | system | auction_id, new_ends_at, extension_no |
| `auction.completed` | system | auction_id, winner_bid_id, final_amount |
| `auction.failed` | system | auction_id, reason (reserve_not_met / no_bids) |
| `auction.cancelled` | admin (4-eyes) | auction_id, reason |

---

## 5. KYC / KYB — DDL

### 5.1. Новые таблицы KYB

```sql
-- Юрлица (инвесторы-фонды, корпорации, основатели-юрлица)
CREATE TABLE business_entities (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(), -- UUIDv7 через расширение/генератор
    legal_name      TEXT NOT NULL,
    legal_form      TEXT,                        -- ООО / АО / ИП / TOO (KZ) / ...
    inn             TEXT,                        -- ИНН (РФ) или аналог; blind index ниже
    ogrn            TEXT,
    jurisdiction    CHAR(2) NOT NULL,            -- ISO 3166-1 alpha-2
    registry_status TEXT CHECK (registry_status IN
                    ('active','liquidating','liquidated','unknown')) DEFAULT 'unknown',
    registry_checked_at TIMESTAMPTZ,             -- последняя сверка с ЕГРЮЛ/ЕГРИП/СМЭВ
    registry_payload_jsonb JSONB,                -- сырой ответ реестра (обезличенные поля)
    -- Blind index для точного поиска по ИНН без хранения открытого значения в индексе:
    inn_hmac        BYTEA GENERATED ALWAYS AS (
                        hmac(inn, current_setting('app.blind_index_key'), 'sha256')) STORED,
    owner_user_id   UUID NOT NULL REFERENCES users(id),  -- представитель, создавший запись
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX business_entities_inn_hmac_uq
    ON business_entities (inn_hmac, jurisdiction) WHERE deleted_at IS NULL;

-- Проверки юрлица (1:N, история)
CREATE TABLE kyb_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id       UUID NOT NULL REFERENCES business_entities(id),
    kind            TEXT NOT NULL CHECK (kind IN
                    ('registry_check','beneficial_owners','accreditation','annual_review')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                    ('pending','in_review','approved','rejected','verification_pending')),
    provider        TEXT CHECK (provider IN ('smev','egrul_api','kyc_provider','manual')),
    provider_ref    TEXT,                        -- id заявки у провайдера
    evidence_ref    TEXT,                        -- s3_key зашифрованного пакета (KEK-домен kyb_documents)
    evidence_wrapped_dek BYTEA,                  -- per-record DEK
    beneficial_owners_jsonb JSONB,               -- [{user_id → kyc_verifications.id, share_pct}]
    rejection_reason TEXT,
    reviewed_by     UUID REFERENCES users(id),   -- комплаенс-офицер (обязателен для approved)
    decided_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- SoD: комплаенс-офицер не может быть владельцем сущности
    CHECK (reviewed_by IS NULL OR status IN ('approved','rejected'))
);

-- Связь пользователя с юрлицом (подписанты, бенефициары)
CREATE TABLE entity_members (
    entity_id       UUID NOT NULL REFERENCES business_entities(id),
    user_id         UUID NOT NULL REFERENCES users(id),
    member_role     TEXT NOT NULL CHECK (member_role IN
                    ('signatory','beneficial_owner','representative')),
    share_pct       NUMERIC(5,2) CHECK (share_pct > 0 AND share_pct <= 100),
    verified_at     TIMESTAMPTZ,                 -- KYC этого лица пройден
    PRIMARY KEY (entity_id, user_id, member_role)
);
```

### 5.2. Изменение `kyc_verifications` (EXPAND-миграция)

```sql
ALTER TABLE kyc_verifications
    ADD COLUMN provider TEXT CHECK (provider IN ('sumsub_class','smev','manual')),
    ADD COLUMN provider_ref TEXT,
    ADD COLUMN doc_type TEXT CHECK (doc_type IN ('passport','foreign_passport','id_card','driver_license')),
    ADD COLUMN doc_country CHAR(2),
    ADD COLUMN liveness_result TEXT CHECK (liveness_result IN ('passed','failed','not_required')),
    ADD COLUMN entity_id UUID REFERENCES business_entities(id),  -- NULL для физлиц-KYC; KYB-бенефициар → заполнен
    ADD COLUMN evidence_wrapped_dek BYTEA;
-- Инвариант сервисного слоя: evidence шифруется ДО загрузки в S3 (KEK-домен kyc_documents).
```

---

## 6. Аукцион — полный DDL

### 6.1. Таблицы

```sql
-- ── Аукционы ────────────────────────────────────────────────────────────────
CREATE TABLE auctions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id          UUID NOT NULL REFERENCES listings(id),
    season_id           UUID NOT NULL REFERENCES seasons(id),

    -- Формат и параметры (конфигурация, задаётся админом)
    format              TEXT NOT NULL CHECK (format IN
                        ('english_open','sealed_first_price','dutch')),
    currency            CHAR(3) NOT NULL,
    min_bid             NUMERIC(14,2) NOT NULL CHECK (min_bid > 0),
    min_increment       NUMERIC(14,2) NOT NULL CHECK (min_increment > 0),
    reserve_price_enc   BYTEA,                   -- резервная цена, envelope-шифрование (KEK auction_sealed)
    reserve_wrapped_dek BYTEA,
    buyout_price        NUMERIC(14,2),           -- опционально: мгновенный выкуп (english_open)
    dutch_schedule_jsonb JSONB,                  -- для dutch: [{at, price}], CHECK ниже

    -- Окно торгов
    scheduled_start_at  TIMESTAMPTZ NOT NULL,
    scheduled_end_at    TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,    -- фактический конец (с продлениями)
    anti_snipe_window_sec INTEGER NOT NULL DEFAULT 120,
    extension_sec       INTEGER NOT NULL DEFAULT 300,
    max_extensions      INTEGER NOT NULL DEFAULT 10,
    extensions_used     INTEGER NOT NULL DEFAULT 0,

    -- Агрегаты (обновляются в транзакции ставки)
    current_bid         NUMERIC(14,2),
    current_bid_id      UUID,
    bids_count          INTEGER NOT NULL DEFAULT 0,

    -- Четырёхглазый принцип: инициатор ≠ подтверждающий
    status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                        ('draft','pending_approval','scheduled','active',
                         'closing','completed','failed','cancelled')),
    created_by          UUID NOT NULL REFERENCES users(id),
    approved_by         UUID REFERENCES users(id),
    cancelled_by        UUID REFERENCES users(id),
    cancel_reason       TEXT,

    winner_bid_id       UUID,
    final_amount        NUMERIC(14,2),

    version             INTEGER NOT NULL DEFAULT 1,   -- optimistic locking
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CHECK (scheduled_end_at > scheduled_start_at),
    CHECK (approved_by IS NULL OR approved_by <> created_by),      -- SoD на уровне БД
    CHECK (cancelled_by IS NULL OR cancelled_by <> created_by),
    CHECK (format <> 'dutch' OR dutch_schedule_jsonb IS NOT NULL),
    CHECK (status <> 'completed' OR (winner_bid_id IS NOT NULL AND final_amount IS NOT NULL))
);

-- Один активный аукцион на листинг
CREATE UNIQUE INDEX auctions_one_active_per_listing
    ON auctions (listing_id)
    WHERE status IN ('pending_approval','scheduled','active','closing');

CREATE INDEX auctions_status_ends ON auctions (status, ends_at)
    WHERE status IN ('scheduled','active');      -- джобы старта/закрытия

-- ── Ставки (append-only) ────────────────────────────────────────────────────
CREATE TABLE auction_bids (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auction_id      UUID NOT NULL REFERENCES auctions(id),
    bidder_id       UUID NOT NULL REFERENCES users(id),
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    currency        CHAR(3) NOT NULL,

    -- Для sealed_first_price сумма дополнительно шифруется:
    amount_enc      BYTEA,                       -- envelope (KEK auction_sealed); NULL для english/dutch
    amount_wrapped_dek BYTEA,

    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN
                    ('active','outbid','winning','won','lost','retracted')),
    idempotency_key TEXT NOT NULL,               -- клиентский UUID
    prev_bid_id     UUID REFERENCES auction_bids(id),  -- цепочка ставок аукциона
    client_ts       TIMESTAMPTZ,                 -- для аналитики расхождения часов
    ip_hash         BYTEA,
    user_agent_hash BYTEA,
    placed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Идемпотентность: повтор с тем же ключом — тот же ответ, не вторая ставка
CREATE UNIQUE INDEX auction_bids_idem_uq ON auction_bids (auction_id, idempotency_key);
CREATE INDEX auction_bids_auction_placed ON auction_bids (auction_id, placed_at DESC);
CREATE INDEX auction_bids_bidder ON auction_bids (bidder_id, placed_at DESC);

-- Текущая максимальная ставка на аукцион — не более одной 'winning'/'active' верхней:
-- обеспечивается транзакцией размещения (§6.3) + этим частичным индексом:
CREATE UNIQUE INDEX auction_bids_one_top_per_auction
    ON auction_bids (auction_id) WHERE status = 'winning';

-- Запрет UPDATE/DELETE на ставках (append-only; смена status — через SECURITY DEFINER)
CREATE OR REPLACE FUNCTION forbid_bid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'auction_bids is append-only';
END $$;

CREATE TRIGGER auction_bids_no_update BEFORE UPDATE OF amount, bidder_id, auction_id ON auction_bids
    FOR EACH ROW EXECUTE FUNCTION forbid_bid_mutation();
CREATE TRIGGER auction_bids_no_delete BEFORE DELETE ON auction_bids
    FOR EACH ROW EXECUTE FUNCTION forbid_bid_mutation();
-- (UPDATE status разрешён: outbid/won/lost/retracted — только сервисной ролью аукциона)

-- Агрегатный VIEW для участников (чужие суммы sealed не раскрываются)
CREATE VIEW auction_public_state AS
SELECT a.id AS auction_id, a.format, a.status, a.ends_at,
       a.bids_count,
       CASE WHEN a.format = 'english_open' THEN a.current_bid END AS current_bid,
       a.extensions_used
FROM auctions a;
```

### 6.2. Размещение ставки — транзакция (защита от гонок)

```sql
-- Выполняется сервисной ролью auctions; READ COMMITTED достаточно за счёт FOR UPDATE.
-- Шаги (в одной транзакции, из сервиса):
--   0. SET LOCAL app.current_user_id / app.current_roles;
--   1. SELECT * FROM auctions WHERE id = $1 FOR UPDATE;          -- блокировка строки аукциона
--   2. Проверки: status='active', now() < ends_at, version = $expected_version,
--      amount >= GREATEST(min_bid, current_bid + min_increment),
--      у инвестора: KYC approved + активный tier + access_grants уровня >= 'full' на листинг,
--      bidder ∉ связанные лица основателя (founders_projects, entity_members);
--      нарушение → RAISE / 409 BID_TOO_LOW | AUCTION_NOT_ACTIVE | ACCESS_DENIED
--   3. UPDATE auction_bids SET status='outbid'                   -- прошлая верхняя
--      WHERE auction_id=$1 AND status='winning';
--   4. INSERT INTO auction_bids (… status='winning', prev_bid_id=…)
--      ON CONFLICT (auction_id, idempotency_key) DO NOTHING     -- идемпотентный повтор
--      RETURNING id;
--   5. Антиснайпинг: IF ends_at - now() < anti_snipe_window_sec
--        AND extensions_used < max_extensions
--      THEN ends_at += extension_sec, extensions_used += 1 → событие auction.extended;
--   6. UPDATE auctions SET current_bid, current_bid_id, bids_count+1,
--        version = version + 1 WHERE id=$1 AND version=$expected_version;  -- optimistic lock
--   7. INSERT INTO outbox_events: auction.bid_placed (+ auction.outbid, auction.extended)
--   Всё атомарно; конфликт версии → 409 LISTING_VERSION_CONFLICT.
```

Закрытие аукциона — джоба `closing` (также `FOR UPDATE`): определение победителя (для sealed — детерминированное вскрытие после KMS-unwrap, время разрешено политикой ключа), проверка резервной цены, перевод ставок в `won`/`lost`, события `auction.completed|failed`, создание черновика `allocations`/`deal_documents` для победителя.

### 6.3. RLS для аукциона

```sql
ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auction_bids ENABLE ROW LEVEL SECURITY;

-- Видеть аукцион: admin/organizer — все; основатель — свой листинг;
-- инвестор — только при активном гранте на листинг.
CREATE POLICY auctions_select ON auctions FOR SELECT USING (
    current_setting('app.current_roles')::text ~ '(admin|organizer)'
    OR EXISTS (SELECT 1 FROM listings l
               JOIN founders_projects fp ON fp.project_id = l.project_id
               WHERE l.id = auctions.listing_id
                 AND fp.user_id = current_setting('app.current_user_id')::uuid)
    OR EXISTS (SELECT 1 FROM access_grants g
               WHERE g.object_type = 'listing'
                 AND g.object_id = auctions.listing_id
                 AND g.subject_user_id = current_setting('app.current_user_id')::uuid
                 AND g.revoked_at IS NULL
                 AND (g.expires_at IS NULL OR g.expires_at > now()))
);
-- INSERT/UPDATE — только сервисной ролью auctions (политики для ролей не создаются → deny by default).

-- Ставки: участник видит только свои; агрегаты — через auction_public_state VIEW.
CREATE POLICY auction_bids_select_own ON auction_bids FOR SELECT USING (
    bidder_id = current_setting('app.current_user_id')::uuid
    OR current_setting('app.current_roles')::text ~ '(admin|organizer)'
    OR EXISTS (SELECT 1 FROM auctions a
               JOIN listings l ON l.id = a.listing_id
               JOIN founders_projects fp ON fp.project_id = l.project_id
               WHERE a.id = auction_bids.auction_id
                 AND fp.user_id = current_setting('app.current_user_id')::uuid
                 AND a.status IN ('completed','failed'))   -- основатель видит историю после завершения
);
-- INSERT — только через сервис аукциона (SECURITY DEFINER функция place_bid),
-- которая сама выставляет app.* и выполняет §6.2. Прямой INSERT ролям запрещён.
```

---

## 7. Уведомления: push / SMS / устройства — DDL

### 7.1. Новые таблицы и изменения

```sql
-- Устройства пользователя (push-токены)
CREATE TABLE user_devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    platform        TEXT NOT NULL CHECK (platform IN ('ios','android','web_pwa')),
    push_provider   TEXT NOT NULL CHECK (push_provider IN ('fcm','apns','web_push')),
    push_token      TEXT NOT NULL,               -- токен устройства; ротация = новая строка
    device_name     TEXT,                        -- «iPhone 15», модель браузера
    app_version     TEXT,
    locale          TEXT,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at      TIMESTAMPTZ,                 -- logout / Unregistered от провайдера
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX user_devices_token_uq
    ON user_devices (user_id, push_token) WHERE revoked_at IS NULL;
CREATE INDEX user_devices_active ON user_devices (user_id) WHERE revoked_at IS NULL;

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_devices_own ON user_devices FOR ALL USING (
    user_id = current_setting('app.current_user_id')::uuid
);
-- Запись delivery-статусов — только сервисной ролью notifications (отдельная GRANT-роль).

-- Версионированные шаблоны уведомлений
CREATE TABLE notification_templates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code            TEXT NOT NULL,               -- 'auction.outbid', 'security.credentials_changed', …
    channel         TEXT NOT NULL CHECK (channel IN ('push','telegram','email','sms','inapp')),
    locale          TEXT NOT NULL DEFAULT 'ru-RU',
    version         INTEGER NOT NULL DEFAULT 1,
    title_template  TEXT,
    body_template   TEXT NOT NULL,               -- плейсхолдеры {{var}}; рендер только на сервере
    fallback_chain  TEXT[] NOT NULL DEFAULT '{}',-- напр. '{push,telegram,email}'
    is_critical     BOOLEAN NOT NULL DEFAULT false,  -- critical игнорирует тихие часы
    is_active       BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (code, channel, locale, version)
);

-- EXPAND-миграция notifications: новые каналы + доставка
ALTER TABLE notifications DROP CONSTRAINT notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check
    CHECK (channel IN ('telegram','email','inapp','push','sms'));
ALTER TABLE notifications
    ADD COLUMN device_id UUID REFERENCES user_devices(id),
    ADD COLUMN provider TEXT,                    -- fcm / apns / smsc / telegram / smtp
    ADD COLUMN provider_ref TEXT,                -- message id провайдера
    ADD COLUMN dedup_key TEXT,                   -- защита от дублей при ретрае события
    ADD COLUMN error_detail TEXT,
    ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX notifications_dedup_uq
    ON notifications (user_id, dedup_key) WHERE dedup_key IS NOT NULL;

-- Расширение предпочтений: темы и тихие часы
ALTER TABLE notification_preferences
    ADD COLUMN topic TEXT NOT NULL DEFAULT 'all',  -- all | auctions | deals | messages | security | marketing
    ADD COLUMN quiet_hours_tz TEXT,                -- 'Europe/Moscow'
    ADD COLUMN quiet_from TIME,
    ADD COLUMN quiet_to TIME;
-- UQ меняется: UNIQUE (user_id, channel, topic)
-- Инвариант: topic='security' и is_critical-шаблоны не отключаются (проверка в сервисе + CHECK-триггер).
```

### 7.2. Матрица каналов (политика, хранится в `notification_templates.fallback_chain`)

| Событие | Цепочка | Примечание |
|---|---|---|
| `auction.outbid`, `auction.extended`, окно открыто | push → telegram → email | стаггер микро-батчами |
| `auction.completed` (победа/проигрыш) | push + sms + email | sms — узкий список критичных шаблонов |
| `security.*` (новый вход, смена реквизитов) | sms + email одновременно | не отключается пользователем |
| OTP восстановления | sms (fallback к passkey) | rate-limit 3/час на номер |
| Дайджесты, маркетинг | telegram/email по предпочтению | отдельное согласие `marketing_communications` |
| Сообщения, Q&A Data Room | push → inapp → email | объединение в дайджест при >5/час |

---

## 8. Конкурентность и целостность — сводка механизмов

| Сценарий | Механизм |
|---|---|
| Двойная ставка (ретрай/двойной тап) | `Idempotency-Key` (API) + UQ (auction_id, idempotency_key) → повтор = тот же ответ |
| Гонка ставок «кто выше» | `SELECT … FOR UPDATE` на строке аукциона + проверка `current_bid + min_increment` в той же транзакции |
| Перезапись агрегата аукциона | optimistic `version` + `expected_version` в API → 409 |
| Два активных аукциона на листинг | частичный UQ `auctions_one_active_per_listing` |
| Два «золотых билета» сверх лимита | CHECK-триггер на сезон (не приложение) |
| Двойная фиксация интереса | частичный UQ (listing_id, investor_id) WHERE stage='committed' |
| TOCTOU доступа к документу | проверка гранта `FOR SHARE` + INSERT `document_views` в одной транзакции; presigned TTL 5 мин |
| Подделка FOMO-счётчиков | инкремент только триггером AFTER INSERT на `events`; сверка счётчик ↔ журнал |
| Двойной платёж | `payments.idempotency_key` UQ + REPEATABLE READ (нагрузочный тест — гейт B) |
| Дубли уведомлений при ретрае события | `consumed_events` (дедуп консьюмера) + `notifications.dedup_key` UQ |
| Включение аукциона одним админом | CHECK `approved_by <> created_by` + статусная машина draft→pending_approval→scheduled |

---

## 9. Индексы и производительность (ключевые)

- `events` — партиции по месяцу (`pg_partman`), индекс (verb, ts DESC) внутри партиции; архив в S3/parquet консьюмером NATS.
- `investment_passports` — HNSW (vector_cosine_ops) + GIN (jsonb_data); `investor_profiles.mandate_embedding` — HNSW.
- `projects` — (season_id, status), (taxonomy_id); FTS-индекс по title/description (`tsvector`, RU+EN конфигурации).
- `listings` — (round_status, season_id); `listing_windows` — (status, closes_at) для джобы закрытия.
- `auctions` — (status, ends_at) частичный для активных; `auction_bids` — (auction_id, placed_at DESC).
- `notifications` — (status, channel, created_at) частичный WHERE status='queued' — очередь воркеров.
- Keyset-пагинация везде в API: `(created_at, id)` курсор, никакого OFFSET.

---

## 10. Миграционный план из текущего состояния

| Шаг | Миграция | Содержание |
|---|---|---|
| M000 | baseline | Расширения, роли БД (app_backend без BYPASSRLS, app_notifications, app_auctions, app_readonly), функция `app_emit_event()`, `forbid_bid_mutation()` |
| M001 | identity | users, user_roles, auth_identities, consents + RLS |
| M002 | projects | taxonomy, projects, founders_projects, versions, materials + RLS |
| M003 | scoring + events | score_models, passports, facts, scores, irs, readiness, roadmaps; events + registry + outbox + counters |
| M004 | experts + seasons | 5 таблиц экспертизы, seasons, golden_tickets |
| M005 | capital | listings, windows, interests, investor_*, matches, dataroom (5), allocation/deal (4) + RLS + VIEW investor_visible_listings |
| M006 | kyc/kyb | kyc_verifications (полная форма), **business_entities, kyb_verifications, entity_members** + RLS |
| M007 | **auctions** | auctions, auction_bids, auction_public_state, политики, verbs в registry, place_bid() |
| M008 | notifications | notifications (расширенная), **notification_templates, user_devices**, preferences (topics) + RLS |
| M009 | billing + show | billing (4), публичные таблицы (в pubDb — отдельный миграционный раннер) |
| M010 | тех. | encryption_keys_registry, agent_runs, feature_flags, mv_listing_funnel_daily, сиды (сезон 1, справочники, шаблоны уведомлений) |

Каждая миграция — с down-скриптом; линтер expand/contract в CI; прод-данные в dev не попадают (только синтетика; staging — анонимизированный дамп: consistent-hash псевдонимизация ПДн, суммы ×0.8–1.2).
