-- M078 — предмет финансирования без значения по умолчанию.
--
-- До этой миграции `funding_scope` создавался как `NOT NULL DEFAULT 'project'`,
-- и новая заявка сразу «отвечала» на вопрос «На что вы привлекаете
-- инвестиции?» — раздел считался частично заполненным до первого действия
-- основателя, а готовность засчитывала ответ, которого никто не давал
-- (замечание владельца после этапа 4).
--
-- Минимальное решение: значения по умолчанию нет. В черновике предмет
-- финансирования пуст, пока основатель его не выберет; при подаче он
-- обязателен — так же, как сумма (условный CHECK, последний рубеж).
--
-- Существующие строки не меняются: у заявок переноса (M071) значение
-- `project` соответствует старой форме, где иного предмета не было.
-- Снятие NOT NULL и DEFAULT — безопасный contract-шаг: ни один читатель не
-- требовал NOT NULL, а код ядра принимает NULL с этой же поставки.

ALTER TABLE lab.investment_applications
    ALTER COLUMN funding_scope DROP NOT NULL,
    ALTER COLUMN funding_scope DROP DEFAULT;

ALTER TABLE lab.investment_applications
    ADD CONSTRAINT applications_submitted_has_scope
    CHECK (status <> 'submitted' OR funding_scope IS NOT NULL);

COMMENT ON COLUMN lab.investment_applications.funding_scope IS
    'Предмет финансирования: project — проект в целом, direction — направление или этап. '
    'NULL в черновике — основатель ещё не выбирал; обязателен при подаче (M078).';
