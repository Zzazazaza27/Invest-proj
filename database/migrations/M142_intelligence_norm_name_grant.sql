-- M142 — право роли приложения на intelligence.norm_name.
--
-- M141 завела функцию сравнения имён для поиска дублей, но не выдала её
-- роли приложения: в этой базе выполнение функций по умолчанию закрыто.
-- Итог — «permission denied for function norm_name» на любом запросе
-- карточки и списка. Функция чистая (IMMUTABLE, без доступа к таблицам),
-- выдавать её безопасно.
GRANT EXECUTE ON FUNCTION intelligence.norm_name(TEXT) TO app_backend;
