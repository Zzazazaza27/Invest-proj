-- =============================================================================
-- M032 — снятие EXECUTE у PUBLIC с функций SECURITY DEFINER
--
-- Находка внешнего аудита, подтверждённая запросом к каталогу: три функции
-- SECURITY DEFINER исполнимы ролью PUBLIC, то есть ЛЮБОЙ ролью с USAGE на
-- схему. PostgreSQL выдаёт EXECUTE роли PUBLIC на каждую новую функцию по
-- умолчанию, и избирательный GRANT нужным ролям этого default НЕ отменяет —
-- он лишь добавляет права поверх уже выданных.
--
-- Чем это опасно именно здесь:
--   * `audit.app_emit_event` пишет журнал от имени указанного актора. Роль,
--     которой журнал положено только читать, могла записать в него событие с
--     чужим actor_id — то есть подделать доказательство действия.
--   * `billing.confirm_first_tranche` подтверждает первый транш и создаёт
--     начисление. Комментарий к ней утверждал «только app_investments», но
--     фактически её мог вызвать любой, кому доступна схема billing.
--   * `ensure_event_partitions` выполняет DDL.
--
-- Второе правило — на будущее: ALTER DEFAULT PRIVILEGES убирает автоматическую
-- выдачу EXECUTE роли PUBLIC для функций, создаваемых владельцем миграций.
-- Без него следующая же SECURITY DEFINER функция воспроизведёт находку, и
-- поймать это можно будет только новым аудитом.
--
-- Проверка после применения — `scripts/check-definer-privileges.mjs`: он
-- пересчитывает функции с EXECUTE у PUBLIC и падает, если такие есть.
-- =============================================================================

REVOKE ALL ON FUNCTION audit.app_emit_event(
    p_verb TEXT, p_actor_id UUID, p_actor_role TEXT, p_subject_type TEXT,
    p_subject_id UUID, p_context JSONB, p_trace_id TEXT) FROM PUBLIC;

REVOKE ALL ON FUNCTION audit.ensure_event_partitions(p_months_ahead INTEGER) FROM PUBLIC;

REVOKE ALL ON FUNCTION billing.confirm_first_tranche(
    p_agreement_id UUID, p_bank_transaction_ref TEXT, p_amount NUMERIC,
    p_booked_at TIMESTAMPTZ, p_statement_sha256 BYTEA, p_actor_id UUID,
    p_trace_id TEXT) FROM PUBLIC;

-- Права, которые действительно нужны, выданы явно в M001/M009 и здесь не
-- трогаются: снятие PUBLIC не отменяет адресный GRANT.

DO $$
BEGIN
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
        current_user);
END $$;

COMMENT ON FUNCTION billing.confirm_first_tranche(UUID, TEXT, NUMERIC, TIMESTAMPTZ, BYTEA, UUID, TEXT) IS
    'Атомарное подтверждение первого транша и начисление вознаграждения. '
    'EXECUTE снят с PUBLIC (M032): вызов доступен только явно перечисленным ролям.';
