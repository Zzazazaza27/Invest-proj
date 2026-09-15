-- M075 — веса готовности заявки: отдельная версионируемая конфигурация.
--
-- «Готовность заявки: N%» считается кодом без ИИ (план 0.2 §4) по весам
-- разделов и баллам состояний из активной строки этой таблицы. Веса живут
-- ОТДЕЛЬНО от конфигурации вопросов (M073) со своей версией и активацией
-- (план 0.2 §2.7, поправка владельца 2026-09-15): правка текста или откат
-- анкеты не должны менять формулу, а смена весов — состав вопросов.
--
-- Активация = новая строка с основанием; прежняя гаснет, но остаётся в
-- истории. Черновики заявок считаются по активной версии; снимок хранит
-- readiness_config_version и completeness_pct навсегда (M071).
--
-- Форма config_jsonb — ReadinessConfigSchema в packages/contracts:
-- { sections: { <ключ раздела>: { weight } }, levelPoints: { mandatory, recommended } }.
-- Раздел без веса считается с весом 1, поэтому новый раздел анкеты не требует
-- новой версии весов.

CREATE TABLE lab.readiness_configs (
    id             UUID PRIMARY KEY,
    version        INTEGER NOT NULL UNIQUE CHECK (version > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version >= 0),
    config_jsonb   JSONB NOT NULL,
    is_active      BOOLEAN NOT NULL DEFAULT false,
    created_by     UUID REFERENCES identity.users(id),         -- NULL у сида
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason         TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE UNIQUE INDEX readiness_configs_one_active
    ON lab.readiness_configs (is_active) WHERE is_active;

COMMENT ON TABLE lab.readiness_configs IS
    'Веса разделов и баллы состояний для расчёта готовности заявки (план 0.2 §2.7, §4). '
    'Одна активная версия; активация — новая строка с основанием. Отдельно от '
    'конфигурации вопросов (M073): свои версии, своя активация.';
COMMENT ON COLUMN lab.readiness_configs.schema_version IS
    'Версия конфигурации вопросов, для разделов которой заданы веса, — справочно.';

ALTER TABLE lab.readiness_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.readiness_configs FORCE  ROW LEVEL SECURITY;

-- Веса читает любой вошедший (готовность считается в кабинете основателя),
-- меняет только администратор.
CREATE POLICY readiness_configs_read ON lab.readiness_configs FOR SELECT
    TO app_backend USING (true);
CREATE POLICY readiness_configs_admin_insert ON lab.readiness_configs FOR INSERT
    TO app_backend WITH CHECK (app.has_role('admin'));
CREATE POLICY readiness_configs_admin_update ON lab.readiness_configs FOR UPDATE
    TO app_backend USING (app.has_role('admin')) WITH CHECK (app.has_role('admin'));

GRANT SELECT, INSERT, UPDATE ON lab.readiness_configs TO app_backend;

-- Стартовые веса — версия 1: все четырнадцать разделов стартовой анкеты по 1,
-- обязательный вопрос вдвое дороже рекомендуемого. Это настройка: владелец
-- меняет её в админке новой версией (этап 5.4), релиз не нужен.
INSERT INTO lab.readiness_configs (id, version, schema_version, config_jsonb, is_active, reason) VALUES
    (public.uuid_generate_v7(), 1, 1,
     '{"sections": {
        "project": {"weight": 1}, "problem": {"weight": 1}, "solution": {"weight": 1},
        "traction": {"weight": 1}, "market": {"weight": 1}, "competition": {"weight": 1},
        "business_model": {"weight": 1}, "team": {"weight": 1}, "execution": {"weight": 1},
        "economics": {"weight": 1}, "funding": {"weight": 1}, "risks": {"weight": 1},
        "legal": {"weight": 1}, "materials": {"weight": 1}},
       "levelPoints": {"mandatory": 2, "recommended": 1}}',
     true, 'Стартовые веса версии 1: разделы равны, обязательный вопрос — 2 балла, рекомендуемый — 1 (план 0.2 §2.7)');
