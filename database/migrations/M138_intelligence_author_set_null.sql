-- M138 — автор записи Market Intelligence не держит запись и не держится ею.
--
-- M137 сослался на identity.users без правила удаления. Следствие: уборка
-- пробных пользователей (`stand:clean-probes`) спотыкалась бы о сущность,
-- заведённую прогоном, а удаление учётной записи — о сведения рынка,
-- которые к человеку не относятся. Сведения ценнее отметки «кто завёл»:
-- при удалении автора отметка пустеет, запись остаётся.
ALTER TABLE intelligence.entities DROP CONSTRAINT IF EXISTS entities_created_by_fkey;
ALTER TABLE intelligence.entities
    ADD CONSTRAINT entities_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES identity.users(id) ON DELETE SET NULL;

ALTER TABLE intelligence.sources DROP CONSTRAINT IF EXISTS sources_created_by_fkey;
ALTER TABLE intelligence.sources
    ADD CONSTRAINT sources_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES identity.users(id) ON DELETE SET NULL;
