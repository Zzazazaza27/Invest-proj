-- M081 — раунд привлечения отдельно от заявки; страна обслуживания аккаунта.
--
-- Решения владельца 2026-09-18 (план 0.2 §0г) и исследование заявка-03 §2.5,
-- §5.3 в редакции этих решений:
--
--  * Проект — профиль бизнеса, живёт без привлечения. Заявка и её версии —
--    сведения и снимки. Раунд — конкретное привлечение: сумма, условия,
--    основание в виде поданной версии профиля. Три разные сущности, ни одна
--    не заменяет другую (§0г.1).
--  * Страна обслуживания хранится ЗА АККАУНТОМ, не за проектом (§0г.2 п.7):
--    выбирается явно при регистрации, не выводится из IP или языка. Условия
--    страны (валюты, бесплатная граница, участие оператора, уведомления) —
--    версионируемая политика, правится из админки; коммерческие значения в
--    коде не зашиваются.
--  * Одна незавершённая кампания на проект: open ИЛИ paused занимают место
--    (§0г.2 п.9). Это правило самостоятельное, не часть политики и не часть
--    оплаты — поэтому оно выражено индексом, а не строкой конфигурации.
--  * Смена основания раунда — тем же раундом с историей оснований (§0г.2 п.9).
--
-- Что НЕ входит в эту миграцию намеренно (вопросы реестра §0г.7, влияющие на
-- структуру данных, обозначены до изменения):
--  * учёт бесплатной границы (исторический максимум target, исключения из
--    учёта): база учёта — по раунду или накопительно — не определена. Колонки
--    появятся следующей expand-миграцией, когда база выбрана; политика хранит
--    basis = null, и бесплатная граница не может быть включена без базы;
--  * пакеты раунда, покупки, комиссия — этап 5.9;
--  * срок раунда и продление — граница оплаченного раунда не согласована.
--
-- Expand-only: таблицы и колонка добавляются; снимаются только три CHECK
-- подачи заявки (сумма и предмет финансирования при подаче), которые
-- противоречат «профиль подаётся без раунда». Ядро до 5.6.3 продолжает
-- требовать их в checkSubmission — БД перестаёт быть последней линией только
-- для этого правила, данные не теряются.

-- ------------------------------------------------------ страны обслуживания
CREATE TABLE billing.service_countries (
    code        TEXT PRIMARY KEY CHECK (code ~ '^[a-z]{2}$'),  -- ISO 3166-1 alpha-2 строчными
    is_active   BOOLEAN NOT NULL DEFAULT false,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE billing.service_countries IS
    'Страны обслуживания: через какую страну аккаунт привлекает или инвестирует '
    '(план 0.2 §0г.2 п.7). Названия, описания и подсказки — в content.text_entries '
    '(namespace service_country), не здесь. Активность — доступность выбора при регистрации.';

CREATE TABLE billing.service_country_policies (
    id           UUID PRIMARY KEY,
    country_code TEXT NOT NULL REFERENCES billing.service_countries(code),
    version      INTEGER NOT NULL CHECK (version > 0),
    config_jsonb JSONB NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT false,
    valid_from   TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID REFERENCES identity.users(id),          -- NULL у сида
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason       TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
    UNIQUE (country_code, version)
);
CREATE UNIQUE INDEX service_country_policies_one_active
    ON billing.service_country_policies (country_code) WHERE is_active;

COMMENT ON TABLE billing.service_country_policies IS
    'Условия обслуживания страны версиями: базовая валюта, разрешённые валюты раундов, '
    'бесплатная граница (включение, сумма, база учёта), участие оператора, уведомления '
    'команде, валютный режим. Форма config_jsonb — ServiceCountryPolicySchema в contracts. '
    'Активация — новая строка с основанием; покупки и опубликованные раунды хранят версию, '
    'применённую в момент действия, и новой версией не переписываются (план 0.2 §0г.2 п.8).';
COMMENT ON COLUMN billing.service_country_policies.config_jsonb IS
    'freeAttraction.basis: null — база учёта не определена (реестр §0г.7), граница не '
    'включается; per_round | cumulative_project — после решения владельца.';

-- Страна за аккаунтом. NULL — не выбрана (регистрация до этапа 5.6.5).
ALTER TABLE identity.users
    ADD COLUMN service_country TEXT REFERENCES billing.service_countries(code);
COMMENT ON COLUMN identity.users.service_country IS
    'Страна обслуживания аккаунта (план 0.2 §0г.2 п.7): явный выбор при регистрации; '
    'не по IP, не по языку, не за проектом. NULL — ещё не выбрана.';

INSERT INTO billing.service_countries (code, is_active, sort_order) VALUES ('ru', true, 10);

-- Стартовая политика российской страны обслуживания — версия 1. Все денежные
-- значения и включатели — настройка: бесплатная граница и платные пакеты
-- выключены до решений реестра (§0г.7), суммы не заданы.
INSERT INTO billing.service_country_policies (id, country_code, version, config_jsonb, is_active, reason) VALUES
    (public.uuid_generate_v7(), 'ru', 1,
     '{"baseCurrency": "RUB",
       "allowedRoundCurrencies": ["RUB"],
       "freeAttraction": {"enabled": false, "amount": null, "basis": null},
       "paidPackages": {"enabled": false},
       "limits": {"maxTargetPerRound": null},
       "operator": {"manualReviewRequired": false,
                    "notify": {"enabled": false, "minTarget": null, "recipients": []}},
       "fx": {"mode": "none"}}',
     true,
     'Стартовые условия: только RUB; бесплатная граница и пакеты выключены до решений реестра 2026-09-18');

-- Существующие аккаунты — единственная активная страна. Это перенос тестовых
-- данных, не правило: новые аккаунты выбирают страну сами (5.6.5).
UPDATE identity.users SET service_country = 'ru' WHERE service_country IS NULL;

ALTER TABLE billing.service_countries        ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.service_countries        FORCE  ROW LEVEL SECURITY;
ALTER TABLE billing.service_country_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.service_country_policies FORCE  ROW LEVEL SECURITY;

-- Список стран читают все, включая анонимную регистрацию; политику — любой
-- вошедший (основатель видит условия до открытия раунда); пишет администратор.
CREATE POLICY service_countries_public_read ON billing.service_countries FOR SELECT
    TO app_public_read USING (is_active);
CREATE POLICY service_countries_read ON billing.service_countries FOR SELECT
    TO app_backend USING (true);
CREATE POLICY service_countries_admin_insert ON billing.service_countries FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY service_countries_admin_update ON billing.service_countries FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

CREATE POLICY service_country_policies_read ON billing.service_country_policies FOR SELECT
    TO app_backend USING (true);
CREATE POLICY service_country_policies_admin_insert ON billing.service_country_policies FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY service_country_policies_admin_update ON billing.service_country_policies FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

GRANT SELECT (code, is_active, sort_order) ON billing.service_countries TO app_public_read;
GRANT SELECT, INSERT, UPDATE ON billing.service_countries        TO app_backend;
GRANT SELECT, INSERT, UPDATE ON billing.service_country_policies TO app_backend;

-- ------------------------------------------------------------------ раунды
CREATE TABLE lab.funding_rounds (
    id                     UUID PRIMARY KEY,
    project_id             UUID NOT NULL REFERENCES lab.projects(id),
    -- Основание: поданная версия профиля. Составной FK — версия обязана
    -- принадлежать тому же проекту (lab.project_versions UNIQUE (project_id, id)).
    application_version_id UUID,
    -- Версия конфигурации формы, по которой заполняются вопросы раунда.
    -- Независима от основания: публикация новой конфигурации открытый раунд не
    -- меняет (заявка-03 §2.5).
    schema_version         INTEGER NOT NULL CHECK (schema_version >= 0),
    status                 TEXT NOT NULL DEFAULT 'draft'
                           CHECK (status IN ('draft','open','paused','closed','cancelled')),
    funding_scope          TEXT CHECK (funding_scope IN ('project','direction')),
    funding_scope_note     TEXT CHECK (funding_scope_note IS NULL OR length(funding_scope_note) <= 200),
    target                 NUMERIC(14,2) CHECK (target IS NULL OR target > 0),
    currency               CHAR(3) CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
    investor_mode          TEXT CHECK (investor_mode IN ('single','multiple','either')),
    ticket_min             NUMERIC(14,2) CHECK (ticket_min IS NULL OR ticket_min > 0),
    ticket_max             NUMERIC(14,2) CHECK (ticket_max IS NULL OR ticket_max > 0),
    -- Со слов основателя. Предварительный интерес инвесторов сюда не попадает;
    -- подтверждённые поступления — контур сделки, не раунд.
    committed              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (committed >= 0),
    committed_source       TEXT NOT NULL DEFAULT 'self_reported' CHECK (committed_source IN ('self_reported')),
    answers_jsonb          JSONB NOT NULL DEFAULT '{}',
    evidence_jsonb         JSONB NOT NULL DEFAULT '{}',
    -- Страна и версия условий, применённые при открытии: снимок, не ссылка на
    -- «текущую» политику (план 0.2 §0г.2 п.8).
    service_country        TEXT REFERENCES billing.service_countries(code),
    policy_version         INTEGER,
    close_reason           TEXT CHECK (close_reason IS NULL OR close_reason IN
                           ('completed','partially_funded','not_funded','withdrawn')),
    created_by             UUID REFERENCES identity.users(id),
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_at              TIMESTAMPTZ,
    paused_at              TIMESTAMPTZ,
    closed_at              TIMESTAMPTZ,
    cancelled_at           TIMESTAMPTZ,
    CONSTRAINT funding_rounds_version_same_project
        FOREIGN KEY (project_id, application_version_id)
        REFERENCES lab.project_versions (project_id, id),
    CONSTRAINT funding_rounds_ticket_order
        CHECK (ticket_min IS NULL OR ticket_max IS NULL OR ticket_min <= ticket_max),
    CONSTRAINT funding_rounds_scope_note
        CHECK (funding_scope IS DISTINCT FROM 'direction' OR funding_scope_note IS NOT NULL),
    -- Незавершённая кампания (open/paused) обязана иметь сумму, предмет,
    -- валюту, основание и условия страны, применённые при открытии.
    CONSTRAINT funding_rounds_unfinished_complete
        CHECK (status NOT IN ('open','paused') OR (
            target IS NOT NULL AND currency IS NOT NULL AND funding_scope IS NOT NULL
            AND application_version_id IS NOT NULL AND opened_at IS NOT NULL
            AND service_country IS NOT NULL AND policy_version IS NOT NULL)),
    CONSTRAINT funding_rounds_closed_has_reason
        CHECK (status <> 'closed' OR (closed_at IS NOT NULL AND close_reason IS NOT NULL)),
    CONSTRAINT funding_rounds_cancelled_has_time
        CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL)
);

-- Одна незавершённая кампания на проект: пауза место не освобождает.
CREATE UNIQUE INDEX funding_rounds_one_unfinished
    ON lab.funding_rounds (project_id) WHERE status IN ('open','paused');
-- Один черновик раунда на проект: «Открыть раунд» продолжает начатое.
CREATE UNIQUE INDEX funding_rounds_one_draft
    ON lab.funding_rounds (project_id) WHERE status = 'draft';
CREATE INDEX funding_rounds_project_status ON lab.funding_rounds (project_id, status);

COMMENT ON TABLE lab.funding_rounds IS
    'Раунд привлечения: конкретное привлечение с суммой, условиями и основанием — поданной '
    'версией профиля (план 0.2 §0г.1, заявка-03 §2.5). Отдельно от заявки и её версий; '
    'проект живёт без раунда. Учёт бесплатной границы и пакеты — следующие миграции, '
    'после решений реестра §0г.7.';
COMMENT ON COLUMN lab.funding_rounds.status IS
    'draft → open → paused ↔ open → closed; любой незавершённый → cancelled. '
    'paused — привлечение приостановлено, не активный поиск денег (три состояния в интерфейсе).';
COMMENT ON COLUMN lab.funding_rounds.close_reason IS
    'Закрытие ≠ поступление денег: completed / partially_funded / not_funded / withdrawn — '
    'со слов основателя; подтверждённые поступления — контур сделки.';

CREATE OR REPLACE FUNCTION lab.funding_rounds_touch() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;
CREATE TRIGGER funding_rounds_touch BEFORE UPDATE ON lab.funding_rounds
    FOR EACH ROW EXECUTE FUNCTION lab.funding_rounds_touch();

-- История оснований: смена версии профиля у раунда — тем же раундом, с
-- восстановимой историей, а не только текущим FK.
CREATE TABLE lab.funding_round_basis_history (
    id              UUID PRIMARY KEY,
    round_id        UUID NOT NULL REFERENCES lab.funding_rounds(id),
    from_version_id UUID REFERENCES lab.project_versions(id),   -- NULL у первого основания
    to_version_id   UUID NOT NULL REFERENCES lab.project_versions(id),
    changed_by      UUID REFERENCES identity.users(id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason          TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE INDEX funding_round_basis_history_round ON lab.funding_round_basis_history (round_id, changed_at);
COMMENT ON TABLE lab.funding_round_basis_history IS
    'Смены основания раунда (заявка-03 §2.5): прежняя и новая версия, автор, время, причина. '
    'Append-only: UPDATE и DELETE не выданы.';

ALTER TABLE lab.funding_rounds             ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.funding_rounds             FORCE  ROW LEVEL SECURITY;
ALTER TABLE lab.funding_round_basis_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.funding_round_basis_history FORCE  ROW LEVEL SECURITY;

-- Раунд читают члены проекта, администратор и назначенный рецензент; пишут
-- члены проекта и администратор. Инвестору раунд отдаётся проекцией Investor
-- View по предикату видимости (этап 5.7) — прямой политики для него здесь
-- нет намеренно: до 5.7 внешний доступ к раунду закрыт целиком.
CREATE POLICY funding_rounds_select ON lab.funding_rounds FOR SELECT TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id())
    OR app.has_role('admin')
    OR experts.is_assigned_reviewer(project_id, app.current_user_id()));
CREATE POLICY funding_rounds_insert ON lab.funding_rounds FOR INSERT TO app_backend WITH CHECK (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
CREATE POLICY funding_rounds_update ON lab.funding_rounds FOR UPDATE TO app_backend USING (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'))
WITH CHECK (
    lab.is_project_member(project_id, app.current_user_id()) OR app.has_role('admin'));
-- DELETE не выдан: раунд отменяется, не удаляется.

CREATE POLICY funding_round_basis_history_select ON lab.funding_round_basis_history FOR SELECT
    TO app_backend USING (EXISTS (
        SELECT 1 FROM lab.funding_rounds r
         WHERE r.id = round_id
           AND (lab.is_project_member(r.project_id, app.current_user_id())
                OR app.has_role('admin')
                OR experts.is_assigned_reviewer(r.project_id, app.current_user_id()))));
CREATE POLICY funding_round_basis_history_insert ON lab.funding_round_basis_history FOR INSERT
    TO app_backend WITH CHECK (EXISTS (
        SELECT 1 FROM lab.funding_rounds r
         WHERE r.id = round_id
           AND (lab.is_project_member(r.project_id, app.current_user_id())
                OR app.has_role('admin'))));

GRANT SELECT, INSERT, UPDATE ON lab.funding_rounds              TO app_backend;
GRANT SELECT, INSERT         ON lab.funding_round_basis_history TO app_backend;

-- ------------------------------------------------ подача профиля без суммы
-- Сумма и предмет финансирования принадлежат раунду; профиль подаётся без них
-- (план 0.2 §0г.2 п.9, заявка-03 §2.6). Снятие CHECK — не потеря данных:
-- колонки остаются как совместимый кеш с одним владельцем пересчёта (5.6.3).
ALTER TABLE lab.investment_applications
    DROP CONSTRAINT applications_submitted_has_ask,
    DROP CONSTRAINT applications_submitted_has_scope_note,
    DROP CONSTRAINT applications_submitted_has_scope;

COMMENT ON COLUMN lab.investment_applications.investment_ask IS
    'Совместимый кеш суммы: с M081 сумма привлечения — у раунда (lab.funding_rounds.target). '
    'Черновики v1 хранят здесь заготовку раунда; подача профиля суммы не требует.';
COMMENT ON COLUMN lab.investment_applications.funding_scope IS
    'Совместимый кеш предмета финансирования: с M081 живёт у раунда. NULL — не выбран.';
