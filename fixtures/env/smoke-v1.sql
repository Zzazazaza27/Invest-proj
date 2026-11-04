-- Тестовый набор среды, версия 1: отметка для проверки загрузки и изоляции.
-- Набор загружается отдельным шагом `scripts/env.mjs seed`, демо-заполнения нет.
INSERT INTO audit.feature_flags (key, enabled)
VALUES ('env-smoke-v1', true)
ON CONFLICT (key) DO NOTHING;
