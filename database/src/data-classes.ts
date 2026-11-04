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
  // -------------------------------------------------------------------- ops
  // Реестр установок (M157): история выпусков среды.
  'ops.installation_events': { kind: 'journal' },
  'ops.installation_targets': { kind: 'journal' },
  'ops.installations': { kind: 'journal' },
  'ops.instances': { kind: 'operational', note: 'подтверждённые версии экземпляров' },
  // ------------------------------------------------------------------ audit
  'audit.consumed_events': { kind: 'journal' },
  'audit.control_objects': {
    kind: 'system',
    note: 'контрольные объекты наблюдения (M153): ключ, размер, SHA-256 — заводит monitoring.mjs и monitor-probe-init.mjs',
  },
  'audit.encryption_keys_registry': { kind: 'system', note: 'домены KEK и ротации' },
  'audit.event_archives': { kind: 'journal' },
  'audit.event_type_registry': { kind: 'system', note: 'допуск событий, только миграциями' },
  'audit.feature_flags': {
    kind: 'content',
    exportable: true,
    note: 'админка → Функции платформы',
    naturalKey: ['key'],
  },
  'audit.outbox_events': { kind: 'journal' },

  // ---------------------------------------------------------------- billing
  'billing.service_countries': { kind: 'content', exportable: true, naturalKey: ['code'] },

  // ------------------------------------------------------------------ comms
  'comms.notification_preferences': { kind: 'operational' },
  'comms.notification_templates': {
    kind: 'content',
    exportable: true,
    naturalKey: ['code', 'channel', 'locale', 'version'],
  },
  'comms.notifications': { kind: 'operational' },
  'comms.operation_notices': { kind: 'operational' },
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

  // ----------------------------------------------------------- intelligence
  // Market Intelligence (M137): владелец копит сведения о рынке руками и
  // импортом. Сброс стенда не должен их уносить — поэтому `content`. В файлы
  // пока не выгружается: у ручной записи нет естественного ключа (TODO.md).
  'intelligence.entities': {
    kind: 'content',
    exportable: false,
    note: 'админка → Market Intelligence',
  },
  'intelligence.sources': {
    kind: 'content',
    exportable: false,
    note: 'источники: сайты и страницы',
  },
  'intelligence.mentions': {
    kind: 'content',
    exportable: false,
    note: 'факты о сущностях: когда, где, в какой роли; с проверкой',
  },
  'intelligence.external_ids': {
    kind: 'content',
    exportable: false,
    note: 'ключи внешних источников; после объединения дублей их несколько',
  },

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
  'identity.revoked_tokens': { kind: 'journal' },
  'identity.staff_capabilities': { kind: 'system', note: 'каталог полномочий (M097)' },
  'identity.staff_capability_grants': { kind: 'operational' },
  'identity.user_avatars': { kind: 'operational' },
  'identity.user_roles': { kind: 'operational' },
  'identity.users': { kind: 'operational' },
  'identity.verification_tokens': { kind: 'operational' },

  // ------------------------------------------------------------ integration
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

  // -------------------------------------------------------------------- kyc
  'kyc.business_entities': { kind: 'operational' },
  'kyc.entity_members': { kind: 'operational' },
  'kyc.kyb_verifications': { kind: 'operational' },
  'kyc.kyc_verifications': { kind: 'operational' },

  // -------------------------------------------------------------------- lab
  'lab.founders_projects': { kind: 'operational' },
  'lab.project_access_exclusions': { kind: 'operational' },
  'lab.project_access_grants': { kind: 'operational' },
  'lab.project_favorites': { kind: 'operational' },
  'lab.project_materials': { kind: 'operational' },
  'lab.material_upload_attempts': { kind: 'operational' },
  'lab.project_media': { kind: 'operational' },
  'lab.project_taxonomy': { kind: 'system', note: 'отрасли и стадии' },
  'lab.projects': { kind: 'operational' },

  // ----------------------------------------------------------------- public
  'public.schema_migrations': { kind: 'system' },

  // ---------------------------------------------------------------- testing
  // Класс `run` — единственный, который уборка сессии удаляет целиком. Но
  // удаляет она ПО ПЕРЕЧНЮ созданных объектов, а не по классу таблицы: сами
  // записи прогона лежат здесь, а созданное им — в обычных рабочих таблицах.
  'testing.sessions': { kind: 'run' },
  'testing.session_participants': { kind: 'run' },
  'testing.session_steps': { kind: 'run' },
  'testing.session_objects': { kind: 'run' },
  'testing.access_contexts': { kind: 'run', note: 'разрешения действовать от чужого лица' },
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
