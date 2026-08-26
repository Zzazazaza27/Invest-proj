-- M065 — материалы проекта видны инвестору с активной подпиской.
--
-- Зачем. Инвестор оплачивает подписку ради полной карточки проекта, а полная
-- карточка без презентации и документов — это тот же тизер. До сих пор
-- материалы видели только участники проекта, администратор, организатор и
-- назначенный рецензент: инвестор не видел ни одного файла, сколько бы ни
-- платил.
--
-- Условия ровно те же, что у паспорта (M006, политика `passports_read`), и это
-- намеренно: два разных правила доступа к одному и тому же проекту разъезжаются
-- при первой же правке.
--
--   * роль инвестора;
--   * активная подписка (`lab.has_active_investor_membership`);
--   * проект опубликован (`listing_status = 'listed'`) и не удалён.
--
-- Снятие листинга или окончание подписки закрывает доступ немедленно: политика
-- проверяется на каждом запросе, а не в момент выдачи ссылки. Поэтому ядро
-- отдаёт файл сам и не выписывает presigned-ссылок на хранилище — такая ссылка
-- пережила бы и подписку, и снятие листинга.
--
-- Разбор материала (`project_material_parses`) — производная того же файла:
-- закрывать его от того, кому открыт сам материал, бессмысленно.

CREATE POLICY materials_select_investor ON lab.project_materials FOR SELECT TO app_backend USING (
    app.has_role('investor')
    AND lab.has_active_investor_membership(app.current_user_id())
    AND EXISTS (SELECT 1 FROM lab.projects p
                WHERE p.id = project_materials.project_id
                  AND p.listing_status = 'listed'
                  AND p.deleted_at IS NULL));

CREATE POLICY parses_select_investor ON lab.project_material_parses FOR SELECT TO app_backend USING (
    EXISTS (SELECT 1 FROM lab.project_materials m
            JOIN lab.projects p ON p.id = m.project_id
            WHERE m.id = project_material_parses.material_id
              AND app.has_role('investor')
              AND lab.has_active_investor_membership(app.current_user_id())
              AND p.listing_status = 'listed'
              AND p.deleted_at IS NULL));
