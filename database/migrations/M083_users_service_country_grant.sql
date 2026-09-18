-- M083 — право менять страну обслуживания аккаунта.
--
-- M056 сузил UPDATE на identity.users до перечня колонок (наименьшие
-- привилегии): новая колонка service_country из M081 в перечень не вошла, и
-- `PUT /me/service-country` падал с «permission denied for table users».
-- Политика RLS users_update_self уже ограничивает строку владельцем; здесь
-- добавляется только колонка.

GRANT UPDATE (service_country) ON identity.users TO app_backend;
