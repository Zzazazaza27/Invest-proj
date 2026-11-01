-- M153 — контрольные объекты для контрольной операции наблюдения
-- (5Э MVP, работа 2.1-W08a; замечание Тэнка при приёмке W08a).
--
-- Требования: блок 8, 8.2 «Что проверяем — контрольная операция»: чтение
-- контрольной записи через приложение и скачивание контрольного файла с
-- проверкой содержимого по 2.5. Только контрольные объекты, без реальных
-- данных; проверка не создаёт записей и внешних последствий.
--
-- Запись хранит ключ контрольного файла в хранилище, его размер и SHA-256.
-- Ядро читает её функцией (пул приложения, без пользовательского контекста),
-- скачивает файл своими учётными данными хранилища и сверяет содержимое.
-- Заводит запись и файл `scripts/monitoring.mjs control-init`.

CREATE TABLE audit.control_objects (
    name        TEXT PRIMARY KEY CHECK (name ~ '^[a-z0-9-]{1,40}$'),
    s3_key      TEXT NOT NULL CHECK (s3_key LIKE 'control/%'),
    size_bytes  BIGINT NOT NULL CHECK (size_bytes > 0),
    sha256      TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit.control_objects IS
    'Контрольные объекты наблюдения: ключ контрольного файла, размер и SHA-256 (блок 8, 8.2; M153).';

REVOKE ALL ON audit.control_objects FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit.control_object(p_name TEXT)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = pg_catalog, audit, pg_temp
AS $$
    SELECT jsonb_build_object('s3Key', s3_key, 'sizeBytes', size_bytes, 'sha256', sha256)
      FROM audit.control_objects
     WHERE name = p_name
$$;

COMMENT ON FUNCTION audit.control_object(TEXT) IS
    'Контрольная запись для служебного порта ядра (/control): ключ файла, размер, SHA-256 (M153).';

REVOKE ALL ON FUNCTION audit.control_object(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit.control_object(TEXT) TO app_backend;
