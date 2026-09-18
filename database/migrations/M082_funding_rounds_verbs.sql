-- M082 — глаголы аудита раундов и условий стран обслуживания (M081).
--
-- Реестр fail-closed (M001): незарегистрированный verb роняет транзакцию.
-- Как в M072/M074/M080, глаголы регистрируются отдельно от схемы.
-- Переходы раунда (opened/paused/resumed/closed/cancelled) уходят и в outbox:
-- хроника развития (U3) подпишется на них позже.

INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.funding_round.created',
     'Создан черновик раунда привлечения',
     ARRAY['founder','admin']),
    ('lab.funding_round.updated',
     'Изменены поля раунда (сумма, условия, ответы вопросов раунда)',
     ARRAY['founder','admin']),
    ('lab.funding_round.opened',
     'Раунд открыт: привлечение активно',
     ARRAY['founder','admin']),
    ('lab.funding_round.paused',
     'Привлечение приостановлено',
     ARRAY['founder','admin']),
    ('lab.funding_round.resumed',
     'Привлечение возобновлено тем же раундом',
     ARRAY['founder','admin']),
    ('lab.funding_round.closed',
     'Раунд закрыт с причиной; обязательства по сделкам не затрагиваются',
     ARRAY['founder','admin']),
    ('lab.funding_round.cancelled',
     'Раунд отменён',
     ARRAY['founder','admin']),
    ('lab.funding_round.basis_changed',
     'Сменено основание раунда — версия профиля; история в funding_round_basis_history',
     ARRAY['founder','admin']),
    ('billing.service_country.updated',
     'Изменены свойства страны обслуживания: активность, порядок',
     ARRAY['admin']),
    ('billing.service_country_policy.activated',
     'Активирована новая версия условий страны обслуживания',
     ARRAY['admin'])
ON CONFLICT (verb) DO NOTHING;
