-- =============================================================================
-- M018 — события регулируемого контура
--
-- Реестр verb'ов fail-closed: событие с незарегистрированным глаголом не
-- пишется, а доменная мутация пишет событие в той же транзакции — значит без
-- этих записей регулируемые операции просто не выполнятся.
--
-- Ключевые глаголы цикла (offer.published, agreement.signed,
-- first_tranche.confirmed, agreement.effective, commission.accrued) уже
-- зарегистрированы в M011. Здесь — недостающие шаги: создание предложения,
-- заключение договора и отказ комплаенса.
-- =============================================================================

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('investment.offer.created',   'Инвестиционное предложение создано (черновик)',
     ARRAY['founder','admin','system']),
    ('investment.offer.rejected',  'Инвестиционное предложение отклонено комплаенсом',
     ARRAY['admin','system']),
    ('investment.agreement.created', 'Инвестор принял предложение: договор сформирован',
     ARRAY['investor','system']),
    ('investment.agreement.signature_added', 'Договор подписан одной из сторон',
     ARRAY['investor','founder','system'])
ON CONFLICT (verb) DO NOTHING;
