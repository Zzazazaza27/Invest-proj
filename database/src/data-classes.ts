/**
 * Классы данных: что в базе справочник, что содержимое, что рабочее, что след.
 *
 * ЗАЧЕМ. «Почистить базу перед запуском» — операция, в которой легко унести
 * нужное. Пока признак «это можно удалять» живёт в голове, он живёт ровно до
 * первой невнимательности. Здесь он записан по таблицам, и проверка
 * `data-classes.test.ts` падает, если появилась таблица, которую не отнесли
 * ни к чему: забыть новую таблицу нельзя.
 *
 * КЛАССЫ.
 *
 *  `system`      — системный справочник. Создают и меняют миграции, человек не
 *                  правит. Восстанавливается накатом миграций на пустую базу;
 *                  выгружать отдельно нечего.
 *
 *  `content`     — редактируемое содержимое и настройки платформы. То, что
 *                  владелец заполняет в админке и что обязано пережить любой
 *                  сброс и доехать до прода: словарь и ЧАВО, вопросы заявки,
 *                  тарифы, страны, шаблоны писем, тексты документов.
 *                  Это и есть предмет выгрузки (`npm run content:export`).
 *
 *  `operational` — рабочие данные участников: люди, проекты, заявки, раунды,
 *                  платежи, рецензии. На стенде это данные прогонов и
 *                  комплектов, на проде — настоящие.
 *
 *  `journal`     — технический журнал: аудит, поток событий, акцепты согласий,
 *                  отозванные токены. Пятый класс сверх четырёх названных
 *                  добавлен намеренно: эти таблицы нельзя чистить ВООБЩЕ,
 *                  даже уборкой конкретного прогона. Журнал событий связан
 *                  хеш-цепочкой (M002) — удаление строки ломает доказуемость
 *                  всей цепочки, а акцепты согласий запрещено менять
 *                  ограничением базы. Класть их в `operational` значило бы
 *                  разрешить их удаление «по общему правилу».
 *
 *  `run`         — данные тестовых сессий: сама сессия, её участники и шаги.
 *                  Единственный класс, который уборка сессии удаляет целиком.
 *
 * ГРАНИЦА, КОТОРУЮ ЛЕГКО СТЕРЕТЬ. Класс отвечает на вопрос «что это за данные
 * по назначению», а НЕ «настоящие они или тестовые». Словарь, заполненный на
 * стенде для переноса в прод, — `content`, хотя заведён в тестовом окружении.
 * Проект, созданный прогоном, — `operational`, хотя он мусор. Происхождение
 * записи (`origin`, M127) и принадлежность тестовой сессии — отдельные
 * признаки, и уборка смотрит на них, а не на класс таблицы.
 */

export type DataClass = 'system' | 'content' | 'operational' | 'journal' | 'run';

export interface TableClass {
  kind: DataClass;
  /**
   * Естественный ключ строки — по нему содержимое узнаётся В ДРУГОЙ БАЗЕ.
   *
   * Первичный ключ для этого не годится: содержимое, засеянное миграциями,
   * в каждой базе получает свой `uuid`. Перенос по первичному ключу дал бы
   * на проде второй комплект шаблонов рядом с первым. Ключ обязан быть
   * подкреплён ограничением уникальности — это проверяет
   * `data-classes.test.ts`.
   */
  naturalKey?: readonly string[];
  /**
   * Выгружается ли таблица класса `content` в файлы.
   *
   * `false` там, где содержимое — секрет: ключи провайдеров и подписи
   * вебхуков настройка по смыслу, но в Git им не место.
   */
  exportable?: boolean;
  note?: string;
}

/**
 * Разделы, которые создаются сами.
 *
 * `pg_partman` заводит новый месяц журнала событий без участия человека —
 * перечислять разделы поимённо значит ломать проверку каждый месяц.
 */
export const PREFIX_CLASSES: ReadonlyArray<{ prefix: string; kind: DataClass }> = [
  { prefix: 'audit.events_', kind: 'journal' },
];

export const DATA_CLASSES: Readonly<Record<string, TableClass>> = {
  // ------------------------------------------------------------------ audit
  'audit.agent_runs': { kind: 'journal' },
  'audit.consumed_events': { kind: 'journal' },
  'audit.encryption_keys_registry': { kind: 'system', note: 'домены KEK и ротации' },
  'audit.event_archives': { kind: 'journal' },
  'audit.event_type_registry': { kind: 'system', note: 'допуск событий, только миграциями' },
  'audit.feature_flags': {
    kind: 'content',
    exportable: true,
    note: 'админка → Функции платформы',
    naturalKey: ['key'],
  },
  'audit.node_checkpoints': { kind: 'journal' },
  'audit.outbox_events': { kind: 'journal' },

  // ---------------------------------------------------------------- billing
  'billing.commission_accruals': { kind: 'operational' },
  'billing.commission_adjustments': { kind: 'operational' },
  'billing.fee_offset_rules': { kind: 'content', exportable: true, naturalKey: ['version'] },
  'billing.fee_offsets': { kind: 'operational' },
  'billing.fee_schedules': { kind: 'content', exportable: true, naturalKey: ['code', 'version'] },
  'billing.invoices': { kind: 'operational' },
  'billing.payment_discrepancies': { kind: 'operational' },
  'billing.payment_events': { kind: 'operational' },
  'billing.payments': { kind: 'operational' },
  'billing.plan_capabilities': { kind: 'system', note: 'каталог возможностей тарифа' },
  'billing.plan_capability_links': {
    kind: 'content',
    exportable: true,
    naturalKey: ['plan_id', 'capability'],
  },
  'billing.purchase_item_runs': { kind: 'operational' },
  'billing.round_package_alternatives': {
    kind: 'content',
    exportable: true,
    naturalKey: ['package_id', 'alternative_id'],
  },
  'billing.round_package_selections': { kind: 'operational' },
  'billing.round_package_services': {
    kind: 'content',
    exportable: true,
    naturalKey: ['package_id', 'service_id'],
  },
  'billing.round_packages': { kind: 'content', exportable: true, naturalKey: ['code', 'version'] },
  'billing.round_purchase_items': { kind: 'operational' },
  'billing.round_purchases': { kind: 'operational' },
  'billing.round_service_offers': {
    kind: 'content',
    exportable: true,
    naturalKey: ['service_id', 'country_code', 'version'],
  },
  'billing.round_services': { kind: 'content', exportable: true, naturalKey: ['code'] },
  'billing.service_countries': { kind: 'content', exportable: true, naturalKey: ['code'] },
  'billing.service_country_policies': {
    kind: 'content',
    exportable: true,
    naturalKey: ['country_code', 'version'],
  },
  'billing.subscription_plans': {
    kind: 'content',
    exportable: true,
    naturalKey: ['code', 'version'],
  },
  'billing.subscriptions': { kind: 'operational' },

  // ------------------------------------------------------------------ comms
  'comms.notification_preferences': { kind: 'operational' },
  'comms.notification_templates': {
    kind: 'content',
    exportable: true,
    naturalKey: ['code', 'channel', 'locale', 'version'],
  },
  'comms.notifications': { kind: 'operational' },
  'comms.operator_notifications': { kind: 'operational' },
  'comms.support_messages': { kind: 'operational' },
  'comms.support_tickets': { kind: 'operational' },
  'comms.user_devices': { kind: 'operational' },

  // ---------------------------------------------------------------- content
  'content.landing_blocks': {
    kind: 'content',
    exportable: true,
    naturalKey: ['key', 'locale', 'valid_from'],
  },
  'content.languages': { kind: 'content', exportable: true, naturalKey: ['code'] },
  'content.text_entries': {
    kind: 'content',
    exportable: true,
    note: 'словарь и ЧАВО',
    naturalKey: ['namespace', 'key'],
  },
  'content.text_versions': {
    kind: 'content',
    exportable: true,
    note: 'словарь и ЧАВО',
    naturalKey: ['entry_id', 'locale', 'field', 'version'],
  },

  // ---------------------------------------------------------------- experts
  'experts.expert_assignments': { kind: 'operational' },
  'experts.expert_conflict_declarations': { kind: 'operational' },
  'experts.expert_notes': { kind: 'operational' },
  'experts.expert_reviews': { kind: 'operational' },
  'experts.experts': { kind: 'operational' },
  'experts.review_consensus': { kind: 'operational' },

  // --------------------------------------------------------------- identity
  'identity.auth_identities': { kind: 'operational' },
  'identity.consent_events': { kind: 'journal' },
  'identity.consent_templates': {
    kind: 'content',
    exportable: true,
    note: 'тексты документов; до прода заменяются настоящими',
    naturalKey: ['kind', 'version', 'locale'],
  },
  'identity.consents': { kind: 'journal', note: 'акцепты неизменяемы (M002)' },
  'identity.investor_profiles': { kind: 'operational' },
  'identity.publication_consents': { kind: 'journal' },
  'identity.revoked_tokens': { kind: 'journal' },
  'identity.staff_capabilities': { kind: 'system', note: 'каталог полномочий (M097)' },
  'identity.staff_capability_grants': { kind: 'operational' },
  'identity.user_avatars': { kind: 'operational' },
  'identity.user_roles': { kind: 'operational' },
  'identity.users': { kind: 'operational' },
  'identity.verification_tokens': { kind: 'operational' },

  // ------------------------------------------------------------ integration
  'integration.deal_commissions': { kind: 'operational' },
  'integration.external_refs': { kind: 'operational' },
  'integration.service_accounts': {
    kind: 'content',
    exportable: false,
    note: 'настройка, но с секретами — в файлы не выгружается',
  },
  'integration.webhook_deliveries': { kind: 'operational' },
  'integration.webhook_endpoints': {
    kind: 'content',
    exportable: false,
    note: 'адреса подписчиков и подписи — в файлы не выгружаются',
  },

  // ------------------------------------------------------------ investments
  'investments.investment_agreements': { kind: 'operational' },
  'investments.investment_offers': { kind: 'operational' },
  'investments.investment_tranches': { kind: 'operational' },
  'investments.nominal_account_transactions': { kind: 'operational' },
  'investments.tranche_returns': { kind: 'operational' },

  // -------------------------------------------------------------------- kyc
  'kyc.business_entities': { kind: 'operational' },
  'kyc.entity_members': { kind: 'operational' },
  'kyc.kyb_verifications': { kind: 'operational' },
  'kyc.kyc_verifications': { kind: 'operational' },

  // -------------------------------------------------------------------- lab
  'lab.application_form_versions': {
    kind: 'content',
    exportable: true,
    note: 'вопросы заявки',
    naturalKey: ['version'],
  },
  'lab.application_policies': { kind: 'content', exportable: true, naturalKey: ['version'] },
  'lab.founders_projects': { kind: 'operational' },
  'lab.funding_round_basis_history': { kind: 'operational' },
  'lab.funding_rounds': { kind: 'operational' },
  'lab.investment_applications': { kind: 'operational' },
  'lab.project_access_exclusions': { kind: 'operational' },
  'lab.project_access_grants': { kind: 'operational' },
  'lab.project_duplicates': { kind: 'operational' },
  'lab.project_favorites': { kind: 'operational' },
  'lab.project_material_parses': { kind: 'operational' },
  'lab.project_materials': { kind: 'operational' },
  'lab.project_media': { kind: 'operational' },
  'lab.project_taxonomy': { kind: 'system', note: 'отрасли и стадии' },
  'lab.project_versions': { kind: 'operational' },
  'lab.projects': { kind: 'operational' },
  'lab.readiness_configs': {
    kind: 'content',
    exportable: true,
    note: 'веса готовности',
    naturalKey: ['version'],
  },

  // ----------------------------------------------------------------- public
  'public.schema_migrations': { kind: 'system' },

  // ---------------------------------------------------------------- scoring
  'scoring.ai_provider_credentials': {
    kind: 'content',
    exportable: false,
    note: 'ключи провайдеров — в файлы не выгружаются',
  },
  'scoring.investment_passports': { kind: 'operational' },
  'scoring.irs_scores': { kind: 'operational' },
  'scoring.passport_facts': { kind: 'operational' },
  'scoring.passport_texts': {
    kind: 'operational',
    note: 'перевод нарратива КОНКРЕТНОГО паспорта — данные проекта, не настройка',
  },
  'scoring.readiness_map': { kind: 'operational' },
  'scoring.roadmap_steps': { kind: 'operational' },
  'scoring.roadmaps': { kind: 'operational' },
  'scoring.score_models': { kind: 'system', note: 'версии модели скоринга' },
  'scoring.scores': { kind: 'operational' },

  // ---------------------------------------------------------------- seasons
  'seasons.golden_tickets': { kind: 'operational' },
  'seasons.seasons': {
    kind: 'content',
    exportable: true,
    note: 'направление отложено (этап 8)',
    naturalKey: ['number'],
  },
};

/** Класс таблицы с учётом правил по префиксу; `null` — таблица не учтена. */
export function classOf(qualifiedName: string): DataClass | null {
  const direct = DATA_CLASSES[qualifiedName];
  if (direct) return direct.kind;
  const byPrefix = PREFIX_CLASSES.find((rule) => qualifiedName.startsWith(rule.prefix));
  return byPrefix ? byPrefix.kind : null;
}

/** Таблицы содержимого, которые выгружаются в файлы. */
export function exportableTables(): string[] {
  return Object.entries(DATA_CLASSES)
    .filter(([, value]) => value.kind === 'content' && value.exportable === true)
    .map(([name]) => name)
    .sort();
}
