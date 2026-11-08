-- M166 — служебные таблицы наблюдений и очереди писем: только служебному контексту ядра
-- (выпуск W13–W21; линтер миграций, CI 42517656709, 09.11.2026).
--
-- M161 и M162 дали роли app_backend сквозные политики `FOR ALL … USING (true)` на
-- availability.observations и comms.mail_queue. app_backend обслуживает и запросы людей,
-- поэтому любой запрос под этой ролью мог читать и менять наблюдения доступности, а также
-- служебные адреса и содержимое писем очереди (копии обращений в поддержку, уведомления о
-- регистрации). Утечки через API это не доказывает — API эти таблицы не отдаёт, — но
-- построчной границы не было. Применённые M161/M162 не правятся: замена — здесь.
--
-- После M166:
--   * observations — чтение и запись только при `app.has_role('system')` (служебная задача
--     наблюдения и сводка групп работают в этом контексте); app_readonly — чтение, как было;
--   * mail_queue — чтение и изменение только при `app.has_role('system')` (отправщик);
--     ПОСТАНОВКА — только функцией comms.enqueue_service_mail в транзакции исходного
--     события: прямой INSERT у app_backend отозван. Функция не возвращает содержимого
--     очереди и не перезаписывает уже поставленное письмо; откат исходной транзакции
--     убирает и письмо (функция — часть той же транзакции).
--   * app_readonly читает очередь, как и раньше (служебные отчёты): это отдельный доступ,
--     M166 его не меняет.

-- ---------------------------------------------------------------- наблюдения
DROP POLICY observations_core ON availability.observations;
CREATE POLICY observations_system ON availability.observations
    FOR ALL TO app_backend
    USING (app.has_role('system'))
    WITH CHECK (app.has_role('system'));

-- ---------------------------------------------------------------- очередь писем
DROP POLICY mail_queue_core ON comms.mail_queue;
CREATE POLICY mail_queue_system ON comms.mail_queue
    FOR ALL TO app_backend
    USING (app.has_role('system'))
    WITH CHECK (app.has_role('system'));

REVOKE INSERT ON comms.mail_queue FROM app_backend;

CREATE OR REPLACE FUNCTION comms.enqueue_service_mail(
    p_id          UUID,
    p_source_type TEXT,
    p_source_id   UUID,
    p_recipient   TEXT,
    p_subject     TEXT,
    p_body        TEXT,
    p_message_id  TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, comms, pg_temp
AS $$
BEGIN
    -- Типы источников — те же, что в ограничении таблицы; неизвестный — отказ до записи.
    IF p_source_type NOT IN ('support.ticket.opened', 'support.message.added',
                             'identity.user.registered') THEN
        RAISE EXCEPTION 'неизвестный источник служебного письма' USING ERRCODE = '22023';
    END IF;
    -- Повтор того же события — без перезаписи: прежнее письмо остаётся как было.
    INSERT INTO comms.mail_queue (id, source_type, source_id, recipient, subject, body, message_id)
    VALUES (p_id, p_source_type, p_source_id, p_recipient, p_subject, p_body, p_message_id)
    ON CONFLICT (source_type, source_id) DO NOTHING;
    -- Только признак «поставлено сейчас» — ни строк, ни содержимого очереди.
    RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION comms.enqueue_service_mail(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT) IS
    'Постановка служебного письма в транзакции события (M166): без чтения очереди, без '
    'перезаписи поставленного; true — поставлено этим вызовом.';

REVOKE ALL ON FUNCTION comms.enqueue_service_mail(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION comms.enqueue_service_mail(UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT)
    TO app_backend;
