-- M156 — RLS для контрольных объектов наблюдения (5Э MVP, работа 2.1-W08a).
--
-- M153 завела `audit.control_objects` без RLS — проверка манифеста RLS это
-- поймала (каждая доменная таблица: ENABLE + FORCE и хотя бы одна политика).
-- Применённая миграция не правится — исправление следующей.
--
-- Прямого чтения таблицы ролями приложения нет и не должно быть: ядро читает
-- её только функцией audit.control_object() (SECURITY DEFINER, M153). Поэтому
-- единственная политика ничего не открывает — она фиксирует намерение.

ALTER TABLE audit.control_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.control_objects FORCE ROW LEVEL SECURITY;

CREATE POLICY control_objects_function_only ON audit.control_objects
    FOR SELECT TO app_backend
    USING (false);

COMMENT ON POLICY control_objects_function_only ON audit.control_objects IS
    'Прямое чтение закрыто: только через audit.control_object() (M153, M156).';
