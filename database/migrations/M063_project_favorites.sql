-- =============================================================================
-- M063 — избранные проекты инвестора
--
-- Инвестор просматривает каталог и хочет вернуться к части проектов позже.
-- До сих пор такой сущности не было ни под именем favorites, ни bookmarks,
-- ни watchlist, ни saved_projects — проверено поиском по схеме и коду.
--
-- Хранится на СЕРВЕРЕ, а не в браузере. Отметка в localStorage выглядит так же
-- ровно до первого входа с другого устройства, а требование «состояние
-- сохраняется после logout/login» она не выполняет вовсе.
--
-- Первичный ключ — сама пара (пользователь, проект). Это не оптимизация: он и
-- есть правило «один и тот же проект нельзя добавить дважды». Уникальность,
-- выраженная отдельным индексом поверх суррогатного id, оставила бы дверь
-- открытой для строки-дубля, если индекс однажды пересоздадут без UNIQUE.
--
-- Схема `lab`: избранное — это отношение к ПРОЕКТУ, и живёт оно рядом с
-- проектами. В `investments` ему не место: там регулируемый контур сделок, а
-- закладка ни к чему не обязывает.
-- =============================================================================

CREATE TABLE lab.project_favorites (
    user_id    UUID NOT NULL REFERENCES identity.users(id),
    project_id UUID NOT NULL REFERENCES lab.projects(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, project_id)
);

-- Список инвестора: свои отметки, свежие сверху.
CREATE INDEX project_favorites_user ON lab.project_favorites (user_id, created_at DESC);

COMMENT ON TABLE lab.project_favorites IS
    'Избранные проекты инвестора. Первичный ключ (user_id, project_id) и есть запрет '
    'на повторное добавление одного проекта. Хранится на сервере: отметка в браузере '
    'не переживает ни другое устройство, ни выход из системы.';

-- ---------------------------------------------------------------------- RLS
ALTER TABLE lab.project_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE lab.project_favorites FORCE  ROW LEVEL SECURITY;

-- Своё — и только своё. Администратора здесь нет намеренно: избранное это
-- предпочтения человека, а не операционные данные платформы, и служебной
-- нужды читать их у администратора не возникает. Права, выданные «на всякий
-- случай», отличаются от нужных только тем, что их никто не отзовёт.
CREATE POLICY project_favorites_own ON lab.project_favorites FOR SELECT
    TO app_backend USING (user_id = app.current_user_id());

-- Добавлять может только инвестор и только себе. Роль проверяется В ПОЛИТИКЕ,
-- а не только в коде маршрута: проверка в одном месте не расходится сама с
-- собой, а две проверки расходятся при первом же изменении — молча.
CREATE POLICY project_favorites_add ON lab.project_favorites FOR INSERT
    TO app_backend WITH CHECK (
        user_id = app.current_user_id()
        AND app.has_role('investor'));

-- Убрать из избранного можно всегда, даже если роль инвестора уже снята:
-- иначе у человека остаётся строка, которую он не может удалить.
CREATE POLICY project_favorites_remove ON lab.project_favorites FOR DELETE
    TO app_backend USING (user_id = app.current_user_id());

-- ---------------------------------------------------------------------- права
-- UPDATE не выдан: у строки нет ни одного изменяемого поля. Отметку ставят и
-- снимают, а не редактируют.
GRANT SELECT, INSERT, DELETE ON lab.project_favorites TO app_backend;
