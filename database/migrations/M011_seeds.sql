-- =============================================================================
-- M011 — сиды
-- Реестр типов событий, фичефлаги, таксономия, сезон 1, тарифы и fee schedule,
-- шаблоны документов (Правила/оферта/ПДн/комиссия), шаблоны уведомлений.
-- Источник: Database_Launch.md §14, §16.1.
--
-- Все вставки идемпотентны: миграция должна безопасно применяться на чистой БД
-- и не ломаться при повторном прогоне в тестовом контуре.
-- =============================================================================

-- --------------------------------------------------- реестр типов событий
INSERT INTO audit.event_type_registry (verb, description, actor_roles_allowed) VALUES
    ('lab.project.submitted',            'Проект подан в сезон',                       ARRAY['founder','system']),
    ('lab.project.scored',               'AI-скоринг завершён',                        ARRAY['system']),
    ('lab.project.status_changed',       'Смена статуса проекта',                      ARRAY['system','admin','organizer']),
    ('lab.project.graduated',            'Выпускник готов к Capital',                  ARRAY['system','admin']),
    ('lab.listing.published',            'Листинг опубликован',                        ARRAY['founder','system']),
    ('lab.listing.unpublished',          'Листинг снят',                               ARRAY['founder','admin','system']),
    ('lab.irs.recalculated',             'IRS пересчитан',                             ARRAY['system']),
    ('investment.offer.published',       'Инвестиционное предложение опубликовано',    ARRAY['admin','system']),
    ('investment.agreement.signed',      'Договор подписан обеими сторонами',          ARRAY['system']),
    ('investment.first_tranche.confirmed','Первый транш подтверждён банком',           ARRAY['system']),
    ('investment.agreement.effective',   'Договор вступил в силу',                     ARRAY['system']),
    ('billing.commission.accrued',       'Вознаграждение ОИП начислено',               ARRAY['system']),
    ('lab.subscription.activated',       'Подписка активирована',                      ARRAY['system']),
    ('lab.subscription.past_due',        'Подписка просрочена',                        ARRAY['system']),
    ('lab.payment.succeeded',            'Платёж в пользу платформы прошёл',           ARRAY['system']),
    ('lab.expert.review_submitted',      'Рецензия эксперта отправлена',               ARRAY['expert']),
    ('lab.consensus.decided',            'Решение консенсуса зафиксировано человеком', ARRAY['admin','organizer']),
    ('lab.season.opened',                'Сезон открыт',                               ARRAY['admin','organizer']),
    ('lab.season.closed',                'Сезон закрыт',                               ARRAY['admin','organizer']),
    ('lab.rating.published',             'Рейтинг сезона опубликован',                 ARRAY['admin','organizer']),
    ('lab.consent.publication_granted',  'Согласие на публичный контур выдано',        ARRAY['founder']),
    ('lab.consent.publication_revoked',  'Согласие на публичный контур отозвано',      ARRAY['founder']),
    ('identity.user.registered',         'Аккаунт создан',                             ARRAY['system']),
    ('identity.user.activated',          'Аккаунт активирован после акцептов',         ARRAY['system']),
    ('identity.consent.accepted',        'Акцепт документа зафиксирован',              ARRAY['founder','investor','expert','organizer','admin','system']),
    ('identity.consent.withdrawn',       'Отзыв отзываемого согласия',                 ARRAY['founder','investor','expert','system']),
    ('kyc.verification.decided',         'Решение по верификации',                     ARRAY['admin','system']),
    ('security.new_login',               'Вход с нового устройства',                   ARRAY['system']),
    ('security.mfa_changed',             'Изменены факторы MFA',                       ARRAY['system'])
ON CONFLICT (verb) DO NOTHING;

-- ------------------------------------------------------------- фичефлаги
-- Регулируемый инвестиционный контур ВЫКЛЮЧЕН до гейта A: включение юрлица в
-- реестр ОИП Банка России и согласование Правил платформы.
INSERT INTO audit.feature_flags (key, enabled, rules_jsonb) VALUES
    ('investments.enabled',            false, '{"gate":"A","requires":"ОИП registry + approved platform rules"}'),
    ('investments.instrument.loan',    false, '{"gate":"A","note":"allowlist утверждается до подачи Правил"}'),
    ('investments.instrument.security', false, '{"gate":"A"}'),
    ('investments.instrument.utility_digital_right', false, '{"gate":"A"}'),
    ('investments.instrument.dfa',     false, '{"gate":"A"}'),
    ('billing.subscriptions.enabled',  true,  '{}'),
    ('ai.scoring.enabled',             true,  '{}'),
    ('ai.mentor.enabled',              false, '{"note":"включается после eval-гейта Langfuse"}'),
    ('show.publication.enabled',       false, '{"note":"медиаконтур — фаза 3 по Architect.md"}'),
    ('capital.integration.enabled',    false, '{"gate":"B"}')
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------------- таксономия
INSERT INTO lab.project_taxonomy (id, parent_id, slug, name_ru, name_en) VALUES
    (public.uuid_generate_v7(), NULL, 'ai',            'AI и автоматизация',   'AI & Automation'),
    (public.uuid_generate_v7(), NULL, 'saas',          'SaaS и сервисы',       'SaaS & Services'),
    (public.uuid_generate_v7(), NULL, 'marketplace',   'Маркетплейсы',         'Marketplaces'),
    (public.uuid_generate_v7(), NULL, 'mobile',        'Мобильные приложения', 'Mobile Apps'),
    (public.uuid_generate_v7(), NULL, 'edtech',        'Онлайн-образование',   'EdTech'),
    (public.uuid_generate_v7(), NULL, 'fintech',       'FinTech',              'FinTech'),
    (public.uuid_generate_v7(), NULL, 'healthtech',    'HealthTech',           'HealthTech'),
    (public.uuid_generate_v7(), NULL, 'web3',          'Web3',                 'Web3'),
    (public.uuid_generate_v7(), NULL, 'gaming',        'Игры',                 'Gaming'),
    (public.uuid_generate_v7(), NULL, 'industrial',    'Промышленность и B2B', 'Industrial & B2B'),
    (public.uuid_generate_v7(), NULL, 'deeptech',      'DeepTech и наука',     'DeepTech'),
    (public.uuid_generate_v7(), NULL, 'other',         'Другое',               'Other')
ON CONFLICT (slug) DO NOTHING;

-- ---------------------------------------------------------------- сезон 1
INSERT INTO seasons.seasons (id, number, title, starts_at, ends_at, status, funnel_config_jsonb)
VALUES (public.uuid_generate_v7(), 1, 'Сезон 1',
        '2026-09-01T00:00:00Z', '2026-12-31T23:59:59Z', 'draft',
        '{"expert_sla_days":7,"reviewers_per_project":2,"third_reviewer_threshold":25}')
ON CONFLICT (number) DO NOTHING;

-- ------------------------------------------------- тарифы (Architect_Launch §5.1)
INSERT INTO billing.subscription_plans
    (id, code, version, audience, name, ask_limit, price, individual_pricing, valid_from) VALUES
    (public.uuid_generate_v7(),'founder_t1',1,'founder','Старт — запрос до 1 млн ₽',          1000000,    4990,   false,'2026-08-09T00:00:00Z'),
    (public.uuid_generate_v7(),'founder_t2',1,'founder','Рост — запрос до 10 млн ₽',          10000000,   9990,   false,'2026-08-09T00:00:00Z'),
    (public.uuid_generate_v7(),'founder_t3',1,'founder','Масштаб — запрос до 100 млн ₽',      100000000,  29990,  false,'2026-08-09T00:00:00Z'),
    (public.uuid_generate_v7(),'founder_t4',1,'founder','Крупный — запрос до 1 млрд ₽',       1000000000, 199990, false,'2026-08-09T00:00:00Z'),
    (public.uuid_generate_v7(),'founder_t5',1,'founder','Стратегический — свыше 1 млрд ₽',    NULL,       NULL,   true, '2026-08-09T00:00:00Z'),
    (public.uuid_generate_v7(),'investor_membership',1,'investor','Подписка инвестора',       NULL,       100000, false,'2026-08-09T00:00:00Z')
ON CONFLICT (code, version) DO NOTHING;

-- --------------------------------- вознаграждение ОИП: 10% инвестор / 5% ЛПИ
INSERT INTO billing.fee_schedules
    (id, code, version, investor_fee_pct, issuer_fee_pct, rules_version, valid_from)
VALUES (public.uuid_generate_v7(),'operator_success_fee',1,10.00,5.00,'platform_rules_v1','2026-08-09T00:00:00Z')
ON CONFLICT (code, version) DO NOTHING;

-- ------------------------------------------- версии обязательных документов
-- body_sha256 — хеш фактического текста. Тексты лежат в
-- docs/legal/<kind>-<version>.md и публикуются в S3; здесь только их отпечаток.
INSERT INTO identity.consent_templates (kind, version, locale, body_sha256, s3_key, published_at) VALUES
    ('platform_rules',          'v1', 'ru-RU', digest('platform_rules_v1_placeholder','sha256'),
     'legal/platform_rules_v1.md',    '2026-08-09T00:00:00Z'),
    ('tos',                     'v1', 'ru-RU', digest('tos_v1_placeholder','sha256'),
     'legal/tos_v1.md',               '2026-08-09T00:00:00Z'),
    ('pdn',                     'v1', 'ru-RU', digest('pdn_v1_placeholder','sha256'),
     'legal/pdn_v1.md',               '2026-08-09T00:00:00Z'),
    ('commission_terms',        'v1', 'ru-RU', digest('commission_terms_v1_placeholder','sha256'),
     'legal/commission_terms_v1.md',  '2026-08-09T00:00:00Z'),
    ('marketing_communications','v1', 'ru-RU', digest('marketing_v1_placeholder','sha256'),
     'legal/marketing_v1.md',         '2026-08-09T00:00:00Z')
ON CONFLICT (kind, version, locale) DO NOTHING;

COMMENT ON TABLE identity.consent_templates IS
    'ВНИМАНИЕ: body_sha256 в сиде — отпечаток плейсхолдера. До production тексты '
    'должны быть утверждены юристом, а хеши пересчитаны от фактических документов.';

-- ----------------------------------------------------- шаблоны уведомлений
-- Политика каналов (Database_Launch.md §10): сервисные push→telegram→email;
-- security sms+email; биллинг-критичные push+email+sms.
INSERT INTO comms.notification_templates
    (id, code, channel, locale, version, title_template, body_template, fallback_chain, is_critical) VALUES
    (public.uuid_generate_v7(),'project.scored','push','ru-RU',1,
     'Оценка готова','Проект «{{project_title}}» получил IRS {{irs}}.',
     ARRAY['telegram','email'], false),
    (public.uuid_generate_v7(),'project.scored','email','ru-RU',1,
     'Оценка проекта готова','Проект «{{project_title}}» получил IRS {{irs}}. Подробности — в кабинете.',
     ARRAY[]::TEXT[], false),

    (public.uuid_generate_v7(),'listing.published','push','ru-RU',1,
     'Листинг опубликован','Проект «{{project_title}}» виден инвесторам.',
     ARRAY['telegram','email'], false),

    (public.uuid_generate_v7(),'investment.agreement.signed','email','ru-RU',1,
     'Договор инвестирования подписан',
     'Договор по проекту «{{project_title}}» подписан обеими сторонами. '
     'Он вступит в силу после подтверждения первого транша.',
     ARRAY[]::TEXT[], true),

    (public.uuid_generate_v7(),'investment.first_tranche.confirmed','email','ru-RU',1,
     'Первый транш подтверждён',
     'Первый транш по договору {{agreement_number}} подтверждён. Договор вступил в силу.',
     ARRAY[]::TEXT[], true),

    (public.uuid_generate_v7(),'billing.commission.accrued','email','ru-RU',1,
     'Счёт на вознаграждение оператора',
     'Начислено вознаграждение оператора: {{amount}} ₽ ({{fee_pct}}% от суммы договора '
     '{{contract_amount}} ₽). Счёт {{invoice_number}}, оплата до {{due_at}}.',
     ARRAY['push','sms'], true),
    (public.uuid_generate_v7(),'billing.commission.accrued','sms','ru-RU',1,
     NULL,'Счёт {{invoice_number}} на {{amount}} ₽. Оплата до {{due_at}}.',
     ARRAY[]::TEXT[], true),

    (public.uuid_generate_v7(),'billing.payment_failed','email','ru-RU',1,
     'Платёж не прошёл',
     'Платёж по счёту {{invoice_number}} не прошёл. Листинг будет снят с публикации '
     'после {{grace_until}}, данные проекта сохранятся.',
     ARRAY['push','sms'], true),

    (public.uuid_generate_v7(),'subscription.past_due','email','ru-RU',1,
     'Подписка просрочена',
     'Подписка по проекту «{{project_title}}» просрочена. Листинг снят с публикации '
     'до возобновления оплаты. Данные сохранены.',
     ARRAY['push'], true),

    (public.uuid_generate_v7(),'expert.assignment','email','ru-RU',1,
     'Новое назначение на экспертизу',
     'Вам назначен проект на рецензию. Срок — до {{due_at}}.',
     ARRAY['telegram'], false),

    (public.uuid_generate_v7(),'security.new_login','sms','ru-RU',1,
     NULL,'Вход в аккаунт с нового устройства {{device}}. Если это не вы — смените пароль.',
     ARRAY['email'], true),
    (public.uuid_generate_v7(),'security.new_login','email','ru-RU',1,
     'Вход с нового устройства',
     'Зафиксирован вход с устройства {{device}} ({{ip_region}}). Если это не вы — '
     'немедленно смените пароль и проверьте факторы MFA.',
     ARRAY[]::TEXT[], true),
    (public.uuid_generate_v7(),'security.mfa_changed','sms','ru-RU',1,
     NULL,'Изменены настройки двухфакторной аутентификации. Если это не вы — свяжитесь с поддержкой.',
     ARRAY['email'], true),

    (public.uuid_generate_v7(),'consent.reaccept_required','email','ru-RU',1,
     'Обновлены тарифы и условия вознаграждения',
     'Опубликована версия {{version}} документа «{{document}}». Ре-акцепт обязателен '
     'до следующей платёжной операции. Grace-период — 14 дней.',
     ARRAY['push'], true)
ON CONFLICT (code, channel, locale, version) DO NOTHING;

-- ----------------------------------------------------------- KEK-домены
INSERT INTO audit.encryption_keys_registry (id, domain, kms_key_id) VALUES
    (public.uuid_generate_v7(),'kyc_documents',            'local/kyc_documents/v1'),
    (public.uuid_generate_v7(),'kyb_documents',            'local/kyb_documents/v1'),
    (public.uuid_generate_v7(),'passport_sensitive',       'local/passport_sensitive/v1'),
    (public.uuid_generate_v7(),'investment_documents',     'local/investment_documents/v1'),
    (public.uuid_generate_v7(),'nominal_account_evidence', 'local/nominal_account_evidence/v1'),
    (public.uuid_generate_v7(),'billing_documents',        'local/billing_documents/v1'),
    (public.uuid_generate_v7(),'search_index',             'local/search_index/v1')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------- активная модель скоринга v0
-- Детерминированная эвристика: работает без внешних LLM и служит baseline'ом
-- для сравнения при подключении реальных моделей (measure or it did not happen).
INSERT INTO scoring.score_models (id, name, version, params_jsonb, is_active) VALUES
    (public.uuid_generate_v7(),'ai_score','v0.1-heuristic',
     '{"weights":{"market":0.15,"demand":0.15,"competitive_edge":0.1,"uniqueness":0.1,'
     '"profitability":0.1,"presentation_quality":0.05,"scalability":0.15,'
     '"investment_readiness":0.1,"product_readiness":0.1},"deterministic":true}', true),
    (public.uuid_generate_v7(),'irs','v0.1-heuristic',
     '{"formula":"weighted_mean(scores)","deterministic":true}', true)
ON CONFLICT (name, version) DO NOTHING;
