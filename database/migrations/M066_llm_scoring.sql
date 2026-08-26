-- M066 — LLM-скоринг: ключ провайдера, тексты паспорта по локалям, флаг включения.
-- ADR-008. Expand-only: ни одна существующая колонка не меняет смысла.

-- ------------------------------------------------------------ ключ провайдера
--
-- Один активный провайдер на платформу: частичный уникальный индекс не даёт
-- завести второй активный ключ, а «какой провайдер сейчас» читается одной
-- строкой без выбора по дате.
--
-- Ключ хранится конвертом (домен KEK `ai_provider_secrets`): база видит только
-- шифртекст и обёрнутый DEK. Отпечаток — для панели: оператор сверяет, тот ли
-- ключ задан, не видя самого ключа. Адрес провайдера здесь не хранится
-- намеренно — он в политике шлюза и проходит ревью.
CREATE TABLE scoring.ai_provider_credentials (
    provider           TEXT PRIMARY KEY CHECK (provider IN
                       ('yandex_gpt','gigachat','anthropic','openai')),
    api_key_ciphertext BYTEA NOT NULL,
    wrapped_dek        BYTEA NOT NULL,
    key_fingerprint    TEXT NOT NULL CHECK (key_fingerprint ~ '^[0-9a-f]{12}$'),
    model_name         TEXT CHECK (model_name IS NULL OR length(model_name) BETWEEN 1 AND 120),
    is_active          BOOLEAN NOT NULL DEFAULT true,
    set_by             UUID NOT NULL REFERENCES identity.users(id),
    set_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_checked_at    TIMESTAMPTZ,
    last_check_ok      BOOLEAN,
    CHECK (last_check_ok IS NULL OR last_checked_at IS NOT NULL)
);
CREATE UNIQUE INDEX ai_provider_credentials_one_active
    ON scoring.ai_provider_credentials (is_active) WHERE is_active;

COMMENT ON TABLE scoring.ai_provider_credentials IS
    'Ключи LLM-провайдеров: конверт домена ai_provider_secrets, один активный на платформу. '
    'Ключ не читается обратно ни одним маршрутом — только отпечаток и метаданные (ADR-008 §2).';

ALTER TABLE scoring.ai_provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.ai_provider_credentials FORCE  ROW LEVEL SECURITY;

-- Чтение — любому запросу ядра: строка нужна прогону анализа под контекстом
-- основателя, а без KEK шифртекст бесполезен и наружу не отдаётся. Запись —
-- только администратору: задать или сменить ключ — операция с деньгами.
CREATE POLICY ai_credentials_read ON scoring.ai_provider_credentials FOR SELECT
    TO app_backend USING (true);
CREATE POLICY ai_credentials_insert ON scoring.ai_provider_credentials FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY ai_credentials_update ON scoring.ai_provider_credentials FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));
CREATE POLICY ai_credentials_delete ON scoring.ai_provider_credentials FOR DELETE
    TO app_backend USING (app.has_role('admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON scoring.ai_provider_credentials TO app_backend;

-- ------------------------------------------------------------ тексты паспорта по локалям
--
-- Канонический текст остаётся в существующих колонках (scores.explanation,
-- readiness_map.recommendations, roadmap_steps.title/description). Перевод
-- ложится отдельной таблицей и привязан к ВЕРСИИ паспорта: новая версия —
-- новые строки. Числа сюда не дублируются: источник правды по ним — scores и
-- irs_scores, разойтись между языками они не могут по построению.
CREATE TABLE scoring.passport_texts (
    passport_id   UUID NOT NULL REFERENCES scoring.investment_passports(id),
    locale        TEXT NOT NULL CHECK (locale IN ('ru-RU','en-US')),
    payload_jsonb JSONB NOT NULL,     -- только переводимые поля (раздел 11.3)
    model_id      UUID REFERENCES scoring.score_models(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (passport_id, locale)
);

COMMENT ON TABLE scoring.passport_texts IS
    'Переводы нарратива паспорта по локалям. Ключ привязывает перевод к версии паспорта; '
    'видимость делегируется паспорту (ADR-008 §5).';

ALTER TABLE scoring.passport_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring.passport_texts FORCE  ROW LEVEL SECURITY;

-- Видимость делегируется паспорту: у перевода не может быть своей аудитории,
-- иначе английский вариант окажется доступен там, где русский закрыт.
CREATE POLICY passport_texts_read ON scoring.passport_texts FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM scoring.investment_passports p
            WHERE p.id = passport_texts.passport_id));
CREATE POLICY passport_texts_write_insert ON scoring.passport_texts FOR INSERT
    TO app_backend WITH CHECK (true);
CREATE POLICY passport_texts_write_update ON scoring.passport_texts FOR UPDATE
    TO app_backend USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON scoring.passport_texts TO app_backend;

-- ------------------------------------------------------------ флаг включения LLM
--
-- Отдельный от ai.scoring.enabled: скоринг эвристикой и скоринг моделью — разные
-- состояния продукта. Сервер отказывается включать этот флаг без активного
-- ключа и зелёного eval-гейта (ADR-008 §6).
INSERT INTO audit.feature_flags (key, enabled, rules_jsonb)
VALUES ('ai.scoring.llm.enabled', false,
        '{"requires":["active_provider_credential","eval_gate_passed"]}')
ON CONFLICT (key) DO NOTHING;
