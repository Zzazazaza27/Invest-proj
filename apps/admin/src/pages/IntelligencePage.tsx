import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  INTEL_ALIVE,
  INTEL_CONTACTS,
  INTEL_DISCOVERY,
  INTEL_LEVELS,
  INTEL_PARSEABLE,
  INTEL_RELIABILITY,
  INTEL_CRAWL_EXTRACT,
  INTEL_CRAWL_MODES,
  INTEL_REVIEW,
  INTEL_SOURCE_VERIFICATION,
  INTEL_SOURCE_TYPES,
  INTEL_STATUSES,
  INTEL_TYPES,
  INTEL_VERIFICATION,
  type IntelCard,
  type IntelEntityInput,
  type IntelFact,
  type IntelFactInput,
  type IntelRow,
  type IntelSource,
  type IntelSourceCard,
  type IntelSourceInput,
  type IntelStatus,
  type IntelType,
  type IntelVerification,
} from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Market Intelligence — профильная база российского инвестиционного рынка.
 *
 * Постановки: docs/product/market-intelligence/ТЗ-MVP.md и ТЗ-перестройка.md.
 * Сущность (человек — всегда «Человек», роли в фактах), источник
 * (профильная площадка или нет) и факт (когда, где, в какой роли, что
 * произошло; подтверждён или кандидат). Показатели считаются только по
 * подтверждённым фактам; главный — число разных профильных площадок.
 *
 * Сортировка и фильтры — на клиенте поверх выборки: записей сотни и
 * тысячи, а не миллионы, и так экран отвечает мгновенно.
 */

export const TYPE_LABEL: Record<IntelType, string> = {
  person: 'Человек',
  organization: 'Организация',
  fund: 'Фонд',
  investor_club: 'Клуб инвесторов',
  accelerator: 'Акселератор',
  venture_studio: 'Венчурная студия',
  bootcamp: 'Буткемп',
  event: 'Мероприятие',
  platform: 'Инвест-платформа',
  media: 'Медиа',
  corporation: 'Корпорация',
  program: 'Программа поддержки',
  project: 'Проект',
  other: 'Другое',
};

export const STATUS_LABEL: Record<IntelStatus, string> = {
  raw: 'Не разобрано',
  reviewed: 'Просмотрено',
  interesting: 'Интересно',
  contacted: 'Был контакт',
  archived: 'В архиве',
};

const STATUS_BADGE: Record<IntelStatus, string> = {
  raw: 'badge badge--muted',
  reviewed: 'badge',
  interesting: 'badge badge--ok',
  contacted: 'badge badge--warn',
  archived: 'badge badge--muted',
};

const SOURCE_TYPE_LABEL: Record<string, string> = {
  fund: 'фонд',
  investor_club: 'клуб инвесторов',
  accelerator: 'акселератор',
  venture_studio: 'венчурная студия',
  incubator: 'инкубатор',
  bootcamp: 'буткемп',
  demo_day: 'Demo Day',
  pitch_session: 'питч-сессия',
  conference: 'форум / конференция',
  competition: 'конкурс стартапов',
  investment_platform: 'инвест-платформа',
  crowdinvesting: 'краудинвестинг',
  investor_catalog: 'каталог инвесторов',
  startup_catalog: 'каталог стартапов',
  community: 'профильное сообщество',
  corporate_program: 'корпоративная программа',
  bank_program: 'программа банка',
  university_program: 'университетская программа',
  gov_program: 'гос. / региональная программа',
  market_portal: 'портал рынка',
  aggregator: 'агрегатор',
  event_calendar: 'календарь мероприятий',
  media: 'СМИ',
  news: 'новостной портал',
  blog: 'блог',
  telegram: 'Telegram-канал',
  general: 'общий сайт',
  speaker_agency: 'агентство спикеров',
  education: 'образование',
  own_site: 'собственный сайт',
  other: 'другое',
};

const VERIFICATION_LABEL: Record<IntelVerification, string> = {
  verified: 'подтверждён',
  candidate: 'кандидат',
  rejected: 'отклонён',
};
const VERIFICATION_BADGE: Record<IntelVerification, string> = {
  verified: 'badge badge--ok',
  candidate: 'badge badge--warn',
  rejected: 'badge badge--muted',
};

const LEVEL_LABEL: Record<string, string> = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const PRIORITY_LABEL: Record<string, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const CONTACTS_LABEL: Record<string, string> = { yes: 'есть', partial: 'частично', no: 'нет' };
const ALIVE_LABEL: Record<string, string> = { yes: 'да', no: 'нет', unknown: 'не проверен' };
const PARSEABLE_LABEL: Record<string, string> = { yes: 'да', partial: 'частично', no: 'нет' };
const REVIEW_LABEL: Record<string, string> = {
  unchecked: 'не разобран',
  checked: 'разобран',
  unreachable: 'не открылся',
};
const DISCOVERY_LABEL: Record<string, string> = {
  direct: 'прямой поиск',
  reverse: 'обратный поиск',
  import: 'импорт',
  manual: 'вручную',
};

const SOURCE_VERIFICATION_LABEL: Record<string, string> = {
  candidate: 'кандидат',
  verified: 'подтверждена',
  rejected: 'отклонена',
};
const CRAWL_MODE_LABEL: Record<string, string> = {
  off: 'не обходить',
  daily: 'ежедневно',
  weekly: 'еженедельно',
};

const CRAWL_EXTRACT_LABEL: Record<string, string> = {
  announcements: 'анонсы',
  jury: 'жюри',
  speakers: 'спикеры',
  deals: 'сделки',
  portfolio: 'портфель',
  team: 'команда',
  calendar: 'календарь',
  catalog: 'каталог участников',
};

const RELIABILITY_LABEL: Record<string, string> = {
  unassessed: 'не оценена',
  reliable: 'надёжная',
  doubtful: 'сомнительная',
};

/**
 * Добавляет ли площадка вес сущностям: профильная, подтверждённая и не
 * сомнительная. Та же формула, что WEIGHTED_SOURCE на сервере.
 */
function weighs(s: IntelSource): boolean {
  return s.isProfile === true && s.verification === 'verified' && s.reliability !== 'doubtful';
}

function profileLabel(value: boolean | null): string {
  return value === true ? 'профильный' : value === false ? 'непрофильный' : 'не разобран';
}

function contactOf(row: IntelRow): string {
  return [
    row.telegram && 'Telegram',
    row.email && 'Email',
    row.linkedin && 'LinkedIn',
    row.websiteUrl && 'Сайт',
  ]
    .filter(Boolean)
    .join(', ');
}

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Дата с той точностью, с какой она известна. */
function dateLabel(value: string | null, precision: 'day' | 'month' | 'year' | null = 'day') {
  if (!value) return null;
  const [y, mo, d] = value.split('-');
  if (precision === 'year') return y!;
  if (precision === 'month') return `${MONTHS[Number(mo) - 1]} ${y}`;
  return `${d}.${mo}.${y}`;
}

/** Сортировка по заголовку колонки: повторный щелчок меняет направление. */
function useSort<K extends string>(initial: K, initialDir: 1 | -1 = 1) {
  const [sort, setSort] = useState<{ key: K; dir: 1 | -1 }>({ key: initial, dir: initialDir });
  const header = (key: K, label: string, numeric = false, title?: string) => (
    <th title={title}>
      <button
        type="button"
        className="intel-sort"
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? (-s.dir as 1 | -1) : numeric || key === 'updatedAt' ? -1 : 1,
          }))
        }
      >
        {label}
        {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
  return { sort, header };
}

function compare(a: string | number, b: string | number): number {
  return typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), 'ru');
}

// ================================================================= оболочка

function Shell({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `intel-tab${isActive ? ' intel-tab--active' : ''}`;
  return (
    <div data-page="intelligence">
      <div className="page-head">
        <div>
          <h1>Market Intelligence</h1>
          <p className="page-hint">
            Профильная база инвестиционного рынка: кто где появляется, в какой роли и что делает.
            Вес сущности — на скольких разных профильных площадках она подтверждённо замечена; СМИ
            обогащают профиль, но в вес не идут.
          </p>
        </div>
        {actions ? <div className="row-actions">{actions}</div> : null}
      </div>
      <div className="intel-tabs">
        <NavLink end to="/intelligence" className={tab}>
          Сущности
        </NavLink>
        <NavLink end to="/intelligence/platforms" className={tab} data-intel-tab-platforms>
          Профильные площадки
        </NavLink>
        <NavLink end to="/intelligence/telegram" className={tab} data-intel-tab-telegram>
          Telegram
        </NavLink>
        <NavLink end to="/intelligence/sources" className={tab}>
          Все источники
        </NavLink>
      </div>
      {children}
    </div>
  );
}

// ============================================================ сущности

type EntitySortKey =
  | 'type'
  | 'name'
  | 'organizationName'
  | 'profileSources'
  | 'mediaFacts'
  | 'contact'
  | 'status'
  | 'updatedAt';

export function IntelligencePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const { sort, header } = useSort<EntitySortKey>('profileSources', -1);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows((await api.intelligence.list({})).items);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить записи'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const needle = q.trim().toLowerCase();
    const value = (r: IntelRow): string | number => {
      switch (sort.key) {
        case 'type':
          return TYPE_LABEL[r.type];
        case 'status':
          return INTEL_STATUSES.indexOf(r.status);
        case 'profileSources':
          // При равном числе площадок выше та, у кого больше профильных фактов.
          return r.metrics.uniqueProfileSources * 10000 + r.metrics.profileFacts;
        case 'mediaFacts':
          return r.metrics.mediaFacts;
        case 'contact':
          return contactOf(r);
        case 'organizationName':
          return r.organizationName ?? '';
        case 'updatedAt':
          return r.updatedAt;
        default:
          return r.name;
      }
    };
    return rows
      .filter(
        (r) =>
          (!type || r.type === type) &&
          (!status || r.status === status) &&
          (!needle ||
            [r.name, r.organizationName, r.description, r.email, r.notes]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(needle))),
      )
      .sort((a, b) => compare(value(a), value(b)) * sort.dir);
  }, [rows, q, type, status, sort]);

  async function importGetInvestor() {
    setImporting(true);
    setNotice(null);
    try {
      const { report } = await api.intelligence.importGetInvestor();
      const lines = report.map((r) =>
        r.error
          ? `${r.catalog}: ошибка — ${r.error}`
          : `${r.catalog}: ${r.fetched} (новых ${r.created}, обновлено ${r.updated})`,
      );
      await load();
      setNotice(`Импорт get-investor.ru завершён. ${lines.join('; ')}.`);
    } catch (err) {
      setError(problemText(err, 'Импорт не выполнен'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Shell
      actions={
        <>
          <button type="button" data-intel-add onClick={() => setAdding(!adding)}>
            Добавить сущность
          </button>
          <button
            type="button"
            className="btn--ghost"
            data-intel-import-gi
            disabled={importing}
            onClick={() => void importGetInvestor()}
          >
            {importing ? 'Импортируем…' : 'Импорт get-investor.ru'}
          </button>
        </>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {adding ? (
        <section className="card">
          <h2>Новая сущность</h2>
          <EntityForm
            withSource
            submitLabel="Сохранить"
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              const card = await api.intelligence.create(input);
              navigate(`/intelligence/${card.entity.id}`);
            }}
          />
        </section>
      ) : null}

      <section className="card">
        <div className="intel-filters">
          <input
            type="search"
            placeholder="Поиск: имя, организация, описание, почта, заметки"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-intel-search
          />
          <select value={type} onChange={(e) => setType(e.target.value)} data-intel-type>
            <option value="">Все типы</option>
            {INTEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} data-intel-status>
            <option value="">Все статусы</option>
            {INTEL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>

        {rows === null ? (
          <div className="spinner">Загрузка…</div>
        ) : rows.length === 0 ? (
          <p className="muted">
            Сущностей пока нет. Добавьте первую вручную или запустите импорт get-investor.ru.
          </p>
        ) : (
          <>
            <div className="small muted" style={{ marginBottom: 6 }}>
              Показано {visible.length} из {rows.length}
            </div>
            <div className="intel-table-wrap">
              <table className="table" data-intel-table>
                <thead>
                  <tr>
                    {header('type', 'Тип')}
                    {header('name', 'Название')}
                    {header('organizationName', 'Организация')}
                    {header(
                      'profileSources',
                      'Профильных площадок',
                      true,
                      'На скольких разных профильных площадках сущность подтверждённо замечена (в скобках — профильных фактов)',
                    )}
                    {header(
                      'mediaFacts',
                      'СМИ',
                      true,
                      'Подтверждённые упоминания в непрофильных источниках',
                    )}
                    {header('contact', 'Контакт')}
                    {header('status', 'Статус')}
                    {header('updatedAt', 'Обновлено')}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.id}
                      className="intel-row"
                      data-intel-row={r.id}
                      onClick={() => navigate(`/intelligence/${r.id}`)}
                    >
                      <td className="small">{TYPE_LABEL[r.type]}</td>
                      <td>
                        <Link to={`/intelligence/${r.id}`} onClick={(e) => e.stopPropagation()}>
                          {r.name}
                        </Link>
                        {r.duplicate ? (
                          <span
                            className="badge badge--warn"
                            style={{ marginLeft: 6 }}
                            title="Есть запись того же типа с тем же нормализованным именем или той же ссылкой"
                          >
                            дубль?
                          </span>
                        ) : null}
                      </td>
                      <td className="small">{r.organizationName ?? '—'}</td>
                      <td className="small" data-intel-weight>
                        <strong>{r.metrics.uniqueProfileSources}</strong>
                        <span className="muted"> ({r.metrics.profileFacts})</span>
                        {r.metrics.candidateFacts > 0 ? (
                          <span className="muted" title="Кандидаты — не проверены, в вес не идут">
                            {' '}
                            +{r.metrics.candidateFacts}?
                          </span>
                        ) : null}
                      </td>
                      <td className="small">{r.metrics.mediaFacts || '—'}</td>
                      <td className="small">{contactOf(r) || '—'}</td>
                      <td>
                        <span className={STATUS_BADGE[r.status]}>{STATUS_LABEL[r.status]}</span>
                      </td>
                      <td className="small muted">
                        {new Date(r.updatedAt).toLocaleDateString('ru-RU')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </Shell>
  );
}

// ============================================================ источники

type SourceSortKey =
  'name' | 'sourceType' | 'profile' | 'review' | 'parserPriority' | 'entityCount' | 'updatedAt';

const LEVEL_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

/**
 * Список источников. `platformsOnly` — карта профильных площадок (ТЗ-
 * перестройка §10): только разобранные и признанные профильными; СМИ и
 * неразобранное туда не попадают.
 */
export function IntelligenceSourcesPage({
  platformsOnly = false,
  telegramOnly = false,
}: {
  platformsOnly?: boolean;
  telegramOnly?: boolean;
}) {
  const navigate = useNavigate();
  const [items, setItems] = useState<IntelSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [profile, setProfile] = useState('');
  const [review, setReview] = useState('');
  const [priority, setPriority] = useState('');
  const [crawl, setCrawl] = useState('');
  const { sort, header } = useSort<SourceSortKey>('entityCount', -1);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setItems(null);
    api.intelligence
      .sources()
      .then((list) => setItems(list.items))
      .catch((err) => setError(problemText(err, 'Не удалось загрузить источники')));
  }, []);

  const visible = useMemo(() => {
    if (!items) return [];
    const needle = q.trim().toLowerCase();
    const value = (s: IntelSource): string | number => {
      switch (sort.key) {
        case 'sourceType':
          return s.sourceType ? (SOURCE_TYPE_LABEL[s.sourceType] ?? s.sourceType) : '';
        case 'profile':
          return s.isProfile === true ? 2 : s.isProfile === false ? 0 : 1;
        case 'review':
          return INTEL_REVIEW.indexOf(s.reviewStatus);
        case 'parserPriority':
          return LEVEL_ORDER[s.parserPriority ?? ''] ?? 0;
        case 'entityCount':
          return s.entityCount;
        case 'updatedAt':
          return s.updatedAt;
        default:
          return s.name ?? s.domain ?? s.url;
      }
    };
    return items
      .filter(
        (s) =>
          (!platformsOnly || (s.isProfile === true && s.verification === 'verified')) &&
          (!telegramOnly || s.sourceType === 'telegram') &&
          (!crawl || (crawl === 'on' ? s.crawlMode !== 'off' : s.crawlMode === 'off')) &&
          (!profile ||
            (profile === 'yes' && s.isProfile === true) ||
            (profile === 'no' && s.isProfile === false) ||
            (profile === 'unknown' && s.isProfile === null)) &&
          (!review || s.reviewStatus === review) &&
          (!priority || s.parserPriority === priority) &&
          (!needle ||
            [s.name, s.url, s.kind, s.description, s.obtainable, s.notes, s.viaEntityName]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(needle))),
      )
      .sort((a, b) => compare(value(a), value(b)) * sort.dir);
  }, [items, q, profile, review, priority, crawl, platformsOnly, telegramOnly, sort]);

  return (
    <Shell
      actions={
        <button type="button" data-intel-source-add onClick={() => setAdding(!adding)}>
          Добавить источник
        </button>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {platformsOnly ? (
        <p className="small muted">
          Карта профильных площадок: только источники, которые после разбора признаны площадками
          инвестиционного рынка. СМИ, блоги и неразобранное — на вкладке «Все источники».
        </p>
      ) : null}
      {telegramOnly ? (
        <p className="small muted">
          Telegram-каналы — такие же площадки, как сайты, выделены отдельной категорией. Канал
          читается через открытое превью t.me/s/… без входа. Метка «обход» — для будущего краулера.
        </p>
      ) : null}
      {adding ? (
        <section className="card">
          <h2>Новый источник</h2>
          <p className="small muted">
            Сайт или страница. Страница загружается, чтобы взять заголовок; адрес сохраняется, даже
            если она сейчас не открывается. Адреса внутренней сети сервер не загружает. Профильный
            ли источник — решает разбор; можно указать сразу, если уже понятно.
          </p>
          <SourceForm
            submitLabel="Сохранить источник"
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              const created = await api.intelligence.createSource(input);
              navigate(`/intelligence/sources/${created.source.id}`);
            }}
          />
        </section>
      ) : null}

      <section className="card" data-intel-sources>
        <div className="intel-filters">
          <input
            type="search"
            placeholder="Поиск: название, адрес, тип, описание, заметки"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-intel-source-search
          />
          {platformsOnly ? null : (
            <select
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              data-intel-profile-filter
            >
              <option value="">Профильные и нет</option>
              <option value="yes">Только профильные</option>
              <option value="no">Только непрофильные</option>
              <option value="unknown">Не разобранные</option>
            </select>
          )}
          <select value={review} onChange={(e) => setReview(e.target.value)}>
            <option value="">Разбор — любой</option>
            {INTEL_REVIEW.map((r) => (
              <option key={r} value={r}>
                {REVIEW_LABEL[r]}
              </option>
            ))}
          </select>
          <select value={crawl} onChange={(e) => setCrawl(e.target.value)} data-intel-crawl-filter>
            <option value="">Обход — любой</option>
            <option value="on">На обходе краулером</option>
            <option value="off">Не обходится</option>
          </select>
          <select value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Приоритет парсера — любой</option>
            {INTEL_LEVELS.map((l) => (
              <option key={l} value={l}>
                {PRIORITY_LABEL[l]}
              </option>
            ))}
          </select>
        </div>
        {items === null ? (
          <div className="spinner">Загрузка…</div>
        ) : (
          <>
            <div className="small muted" style={{ marginBottom: 6 }}>
              Показано {visible.length} из {items.length}
            </div>
            {visible.length === 0 ? (
              <p className="muted">
                {platformsOnly
                  ? 'Профильных площадок пока нет: источники ещё не разобраны.'
                  : 'Под отбор ничего не подходит.'}
              </p>
            ) : (
              <div className="intel-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      {header('name', 'Источник')}
                      {header('sourceType', 'Тип')}
                      {header('profile', 'Профильный', true)}
                      {header('review', 'Разбор')}
                      {header('parserPriority', 'Парсер', true)}
                      {header('entityCount', 'Сущностей', true)}
                      {header('updatedAt', 'Обновлён')}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((s) => (
                      <tr
                        key={s.id}
                        className="intel-row"
                        data-intel-source-row={s.id}
                        onClick={() => navigate(`/intelligence/sources/${s.id}`)}
                      >
                        <td>
                          <Link
                            to={`/intelligence/sources/${s.id}`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {s.name ?? s.domain ?? s.url}
                          </Link>
                          <div className="small muted">
                            {s.domain ?? s.url} · {DISCOVERY_LABEL[s.discovery]}
                            {s.viaEntityName ? ` от «${s.viaEntityName}»` : ''}
                          </div>
                        </td>
                        <td className="small">
                          {s.sourceType ? SOURCE_TYPE_LABEL[s.sourceType] : (s.kind ?? '—')}
                        </td>
                        <td className="small">
                          <span
                            className={
                              s.isProfile === true
                                ? 'badge badge--ok'
                                : s.isProfile === false
                                  ? 'badge badge--muted'
                                  : 'badge badge--warn'
                            }
                          >
                            {profileLabel(s.isProfile)}
                          </span>
                          {s.reliability === 'doubtful' ? (
                            <div>
                              <span className="badge badge--warn">сомнительная</span>
                            </div>
                          ) : null}
                          {s.crawlMode !== 'off' ? (
                            <div>
                              <span className="badge badge--ok" data-intel-crawl-badge>
                                обход: {CRAWL_MODE_LABEL[s.crawlMode]}
                              </span>
                            </div>
                          ) : null}
                        </td>
                        <td className="small">
                          {SOURCE_VERIFICATION_LABEL[s.verification]}
                          <div className="muted">
                            {REVIEW_LABEL[s.reviewStatus]}
                            {weighs(s) ? ' · даёт вес' : ''}
                          </div>
                        </td>
                        <td className="small">
                          {s.parserPriority ? PRIORITY_LABEL[s.parserPriority] : '—'}
                        </td>
                        <td className="small">
                          <strong>{s.entityCount}</strong>
                          {s.factCount > s.verifiedCount ? (
                            <span className="muted">
                              {' '}
                              · кандидатов {s.factCount - s.verifiedCount}
                            </span>
                          ) : null}
                        </td>
                        <td className="small muted">
                          {new Date(s.updatedAt).toLocaleDateString('ru-RU')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </Shell>
  );
}

// ========================================================== форма сущности

const emptyEntity = (): IntelEntityInput & { sourceUrl: string } => ({
  type: 'person',
  name: '',
  organizationName: '',
  description: '',
  websiteUrl: '',
  email: '',
  telegram: '',
  linkedin: '',
  status: 'raw',
  notes: '',
  sourceUrl: '',
});

function EntityForm({
  initial,
  withSource,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: IntelEntityInput;
  withSource?: boolean;
  submitLabel: string;
  onSubmit: (input: IntelEntityInput & { sourceUrl?: string | null }) => Promise<void>;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState({ ...emptyEntity(), ...initial });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { sourceUrl, ...rest } = form;
      await onSubmit(withSource ? { ...rest, sourceUrl: sourceUrl || null } : rest);
    } catch (err) {
      setError(problemText(err, 'Запись не сохранена'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} data-intel-form>
      {error && <div className="alert alert--error">{error}</div>}
      <div className="grid-3">
        <div className="field">
          <label>Тип</label>
          <select value={form.type} onChange={set('type')} name="type">
            {INTEL_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          <div className="field__hint">
            Человек — всегда «Человек»; инвестор, спикер, партнёр — роли в фактах.
          </div>
        </div>
        <div className="field">
          <label>Название / ФИО *</label>
          <input value={form.name} onChange={set('name')} required maxLength={300} name="name" />
        </div>
        <div className="field">
          <label>Основная организация</label>
          <input
            value={form.organizationName ?? ''}
            onChange={set('organizationName')}
            maxLength={300}
            name="organizationName"
          />
        </div>
      </div>
      <div className="field">
        <label>Краткое описание</label>
        <textarea rows={3} value={form.description ?? ''} onChange={set('description')} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Сайт</label>
          <input
            value={form.websiteUrl ?? ''}
            onChange={set('websiteUrl')}
            placeholder="https://…"
            name="websiteUrl"
          />
        </div>
        <div className="field">
          <label>Email</label>
          <input value={form.email ?? ''} onChange={set('email')} name="email" />
        </div>
        <div className="field">
          <label>Telegram</label>
          <input
            value={form.telegram ?? ''}
            onChange={set('telegram')}
            placeholder="@… или https://t.me/…"
          />
        </div>
        <div className="field">
          <label>LinkedIn</label>
          <input value={form.linkedin ?? ''} onChange={set('linkedin')} />
        </div>
      </div>
      {withSource ? (
        <div className="field">
          <label>Где найдено (адрес страницы)</label>
          <input
            value={form.sourceUrl}
            onChange={set('sourceUrl')}
            placeholder="https://…"
            name="sourceUrl"
          />
          <div className="field__hint">
            Станет фактом-кандидатом: подтвердить его можно в карточке, когда страница проверена.
          </div>
        </div>
      ) : null}
      <div className="grid-3">
        <div className="field">
          <label>Статус работы</label>
          <select value={form.status} onChange={set('status')}>
            {INTEL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label>Заметки</label>
        <textarea rows={3} value={form.notes ?? ''} onChange={set('notes')} />
      </div>
      <FormButtons
        busy={busy}
        disabled={!form.name.trim()}
        label={submitLabel}
        onCancel={onCancel}
      />
    </form>
  );
}

function FormButtons({
  busy,
  disabled,
  label,
  onCancel,
}: {
  busy: boolean;
  disabled?: boolean;
  label: string;
  onCancel?: () => void;
}) {
  return (
    <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
      <button type="submit" disabled={busy || disabled}>
        {busy ? 'Сохраняем…' : label}
      </button>
      {onCancel ? (
        <button type="button" className="btn--ghost" onClick={onCancel}>
          Отмена
        </button>
      ) : null}
    </div>
  );
}

// ========================================================= форма источника

type SourceFormState = Record<keyof IntelSourceInput, string>;

const boolText = (v: boolean | null | undefined) =>
  v === true ? 'true' : v === false ? 'false' : '';
const textBool = (v: string) => (v === 'true' ? true : v === 'false' ? false : null);

function sourceState(initial?: IntelSource): SourceFormState {
  return {
    url: initial?.url ?? '',
    name: initial?.name ?? '',
    kind: initial?.kind ?? '',
    description: initial?.description ?? '',
    obtainable: initial?.obtainable ?? '',
    structure: initial?.structure ?? '',
    publicContacts: initial?.publicContacts ?? '',
    alive: initial?.alive ?? '',
    parserPriority: initial?.parserPriority ?? '',
    discovery: initial?.discovery ?? 'direct',
    viaEntityId: initial?.viaEntityId ?? '',
    representsEntityId: initial?.representsEntityId ?? '',
    notes: initial?.notes ?? '',
    isProfile: boolText(initial?.isProfile),
    sourceType: initial?.sourceType ?? '',
    hasEvents: boolText(initial?.hasEvents),
    hasParticipantLists: boolText(initial?.hasParticipantLists),
    parseable: initial?.parseable ?? '',
    reviewStatus: initial?.reviewStatus ?? 'unchecked',
    verification: initial?.verification ?? 'candidate',
    reliability: initial?.reliability ?? 'unassessed',
    crawlMode: initial?.crawlMode ?? 'off',
    crawlExtract: (initial?.crawlExtract ?? []).join(','),
    crawlRule: initial?.crawlRule ?? '',
  };
}

function SourceForm({
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: IntelSource;
  submitLabel: string;
  onSubmit: (input: IntelSourceInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(sourceState(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof SourceFormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        ...form,
        url: form.url.trim(),
        isProfile: textBool(form.isProfile),
        hasEvents: textBool(form.hasEvents),
        hasParticipantLists: textBool(form.hasParticipantLists),
        crawlExtract: form.crawlExtract ? form.crawlExtract.split(',') : [],
        crawlRule: form.crawlRule.trim() || null,
      });
    } catch (err) {
      setError(problemText(err, 'Источник не сохранён'));
    } finally {
      setBusy(false);
    }
  }

  const choice = (
    key: keyof SourceFormState,
    values: readonly string[],
    labels: Record<string, string>,
  ) => (
    <select value={form[key]} onChange={set(key)} name={key}>
      <option value="">не указано</option>
      {values.map((v) => (
        <option key={v} value={v}>
          {labels[v]}
        </option>
      ))}
    </select>
  );
  const tri = (key: keyof SourceFormState) => (
    <select value={form[key]} onChange={set(key)} name={key}>
      <option value="">не знаю</option>
      <option value="true">да</option>
      <option value="false">нет</option>
    </select>
  );

  return (
    <form onSubmit={(e) => void submit(e)} data-intel-source-form>
      {error && <div className="alert alert--error">{error}</div>}
      <div className="grid-2">
        <div className="field">
          <label>Адрес *</label>
          <input
            value={form.url}
            onChange={set('url')}
            required
            placeholder="https://…"
            name="url"
          />
        </div>
        <div className="field">
          <label>Название</label>
          <input
            value={form.name}
            onChange={set('name')}
            name="name"
            placeholder="возьмётся из заголовка страницы"
          />
        </div>
      </div>
      <div className="grid-3">
        <div className="field">
          <label>Профильная площадка?</label>
          <select value={form.isProfile} onChange={set('isProfile')} name="isProfile">
            <option value="">не разобран</option>
            <option value="true">профильный</option>
            <option value="false">непрофильный</option>
          </select>
        </div>
        <div className="field">
          <label>Тип источника</label>
          {choice('sourceType', INTEL_SOURCE_TYPES, SOURCE_TYPE_LABEL)}
        </div>
        <div className="field">
          <label>Разбор</label>
          <select value={form.reviewStatus} onChange={set('reviewStatus')} name="reviewStatus">
            {INTEL_REVIEW.map((r) => (
              <option key={r} value={r}>
                {REVIEW_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Площадка проверена</label>
          <select value={form.verification} onChange={set('verification')} name="verification">
            {INTEL_SOURCE_VERIFICATION.map((v) => (
              <option key={v} value={v}>
                {SOURCE_VERIFICATION_LABEL[v]}
              </option>
            ))}
          </select>
          <div className="field__hint">Подтверждена — открыта и классифицирована.</div>
        </div>
        <div className="field">
          <label>Достоверность для карты рынка</label>
          <select value={form.reliability} onChange={set('reliability')} name="reliability">
            {INTEL_RELIABILITY.map((v) => (
              <option key={v} value={v}>
                {RELIABILITY_LABEL[v]}
              </option>
            ))}
          </select>
          <div className="field__hint">
            Сомнительная хранит факты, но веса сущностям не добавляет.
          </div>
        </div>
      </div>
      <div className="grid-2" data-intel-crawl>
        <div className="field">
          <label>Обход краулером</label>
          <select value={form.crawlMode} onChange={set('crawlMode')} name="crawlMode">
            {INTEL_CRAWL_MODES.map((v) => (
              <option key={v} value={v}>
                {CRAWL_MODE_LABEL[v]}
              </option>
            ))}
          </select>
          <div className="field__hint">Метка для регулярного обхода; сам краулер — позже.</div>
        </div>
        <div className="field">
          <label>Что снимать при обходе</label>
          <div className="intel-checks">
            {INTEL_CRAWL_EXTRACT.map((v) => {
              const chosen = form.crawlExtract ? form.crawlExtract.split(',') : [];
              return (
                <label key={v} className="small">
                  <input
                    type="checkbox"
                    name="crawlExtract"
                    value={v}
                    checked={chosen.includes(v)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...chosen, v]
                        : chosen.filter((x) => x !== v);
                      setForm((f) => ({ ...f, crawlExtract: next.join(',') }));
                    }}
                  />{' '}
                  {CRAWL_EXTRACT_LABEL[v]}
                </label>
              );
            })}
          </div>
        </div>
      </div>
      <div className="field">
        <label>Правило обхода</label>
        <input
          value={form.crawlRule}
          onChange={set('crawlRule')}
          name="crawlRule"
          placeholder="какой раздел или какие посты читать и что заносить в базу"
        />
      </div>
      <div className="field">
        <label>Кратко</label>
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Что даёт</label>
          <input value={form.obtainable} onChange={set('obtainable')} />
        </div>
        <div className="field">
          <label>Как найден</label>
          <select value={form.discovery} onChange={set('discovery')} name="discovery">
            {INTEL_DISCOVERY.map((d) => (
              <option key={d} value={d}>
                {DISCOVERY_LABEL[d]}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid-3">
        <div className="field">
          <label>Есть события</label>
          {tri('hasEvents')}
        </div>
        <div className="field">
          <label>Есть списки участников</label>
          {tri('hasParticipantLists')}
        </div>
        <div className="field">
          <label>Можно парсить</label>
          {choice('parseable', INTEL_PARSEABLE, PARSEABLE_LABEL)}
        </div>
        <div className="field">
          <label>Структурированность</label>
          {choice('structure', INTEL_LEVELS, LEVEL_LABEL)}
        </div>
        <div className="field">
          <label>Публичные контакты</label>
          {choice('publicContacts', INTEL_CONTACTS, CONTACTS_LABEL)}
        </div>
        <div className="field">
          <label>Сайт жив</label>
          {choice('alive', INTEL_ALIVE, ALIVE_LABEL)}
        </div>
        <div className="field">
          <label>Приоритет для парсера</label>
          {choice('parserPriority', INTEL_LEVELS, PRIORITY_LABEL)}
        </div>
      </div>
      <div className="field">
        <label>Заметки</label>
        <textarea rows={3} value={form.notes} onChange={set('notes')} />
      </div>
      <FormButtons
        busy={busy}
        disabled={!form.url.trim()}
        label={submitLabel}
        onCancel={onCancel}
      />
    </form>
  );
}

// ================================================ выбор сущности в форме

/**
 * Выбор организации или события для факта: поиск по имени среди сущностей.
 * Новую организацию заводят отдельно («Добавить сущность») — факт ссылается
 * только на существующую, чтобы не плодить дубли опечатками.
 */
function EntityPicker({
  value,
  onChange,
  placeholder,
  name,
}: {
  value: { id: string; name: string } | null;
  onChange: (next: { id: string; name: string } | null) => void;
  placeholder: string;
  name: string;
}) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<{ id: string; name: string; type: IntelType }[]>([]);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) {
      setOptions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      api.intelligence
        .lookup(needle)
        .then((r) => setOptions(r.items))
        .catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  if (value) {
    return (
      <div className="intel-picked" data-intel-picked={name}>
        <span>{value.name}</span>
        <button type="button" className="btn--ghost btn--sm" onClick={() => onChange(null)}>
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="intel-picker">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        data-intel-picker={name}
      />
      {options.length > 0 ? (
        <ul className="intel-picker__list">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="btn--ghost btn--sm"
                onClick={() => {
                  onChange({ id: o.id, name: o.name });
                  setQ('');
                  setOptions([]);
                }}
              >
                {o.name} <span className="muted">· {TYPE_LABEL[o.type]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ================================================================ факты

type FactState = {
  url: string;
  role: string;
  action: string;
  happenedOn: string;
  happenedPrecision: 'day' | 'month' | 'year';
  organization: { id: string; name: string } | null;
  event: { id: string; name: string } | null;
  verification: IntelVerification;
  evidence: string;
};

const emptyFact = (): FactState => ({
  url: '',
  role: '',
  action: '',
  happenedOn: '',
  happenedPrecision: 'day',
  organization: null,
  event: null,
  verification: 'candidate',
  evidence: '',
});

const factState = (f: IntelFact): FactState => ({
  url: f.pageUrl ?? '',
  role: f.role ?? '',
  action: f.action ?? '',
  happenedOn: f.happenedOn ?? '',
  happenedPrecision: f.happenedPrecision ?? 'day',
  organization: f.organizationId ? { id: f.organizationId, name: f.organizationName ?? '' } : null,
  event: f.eventId ? { id: f.eventId, name: f.eventName ?? '' } : null,
  verification: f.verification,
  evidence: f.evidence ?? '',
});

const factPayload = (v: FactState): IntelFactInput => ({
  role: v.role.trim() || null,
  action: v.action.trim() || null,
  happenedOn: v.happenedOn || null,
  happenedPrecision: v.happenedOn ? v.happenedPrecision : null,
  organizationId: v.organization?.id ?? null,
  eventId: v.event?.id ?? null,
  verification: v.verification,
  evidence: v.evidence.trim() || null,
});

/** Поля факта: одинаковы при добавлении и правке. */
function FactFields({
  value,
  onChange,
  withUrl,
}: {
  value: FactState;
  onChange: (next: FactState) => void;
  withUrl: boolean;
}) {
  const set = (key: keyof FactState) => (e: { target: { value: string } }) =>
    onChange({ ...value, [key]: e.target.value });
  return (
    <div className="intel-fact-form">
      {withUrl ? (
        <input
          value={value.url}
          onChange={set('url')}
          placeholder="Конкретная страница: https://…"
          className="intel-fact-form__wide"
          data-intel-fact-url
        />
      ) : null}
      <input
        value={value.role}
        onChange={set('role')}
        placeholder="Роль: инвестор, спикер, managing partner…"
        data-intel-fact-role
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="date"
          value={value.happenedOn}
          onChange={set('happenedOn')}
          aria-label="Когда было"
          data-intel-fact-date
        />
        <select
          value={value.happenedPrecision}
          onChange={set('happenedPrecision')}
          aria-label="Точность даты"
          style={{ width: 110 }}
        >
          <option value="day">день</option>
          <option value="month">месяц</option>
          <option value="year">год</option>
        </select>
      </div>
      <EntityPicker
        name="organization"
        value={value.organization}
        onChange={(organization) => onChange({ ...value, organization })}
        placeholder="Организация: начните вводить название"
      />
      <EntityPicker
        name="event"
        value={value.event}
        onChange={(event) => onChange({ ...value, event })}
        placeholder="Событие: Demo Day, форум…"
      />
      <input
        value={value.action}
        onChange={set('action')}
        placeholder="Что произошло: вложился в…, выступил про…, вошёл в жюри…"
        className="intel-fact-form__wide"
        data-intel-fact-action
      />
      <input
        value={value.evidence}
        onChange={set('evidence')}
        placeholder="Цитата со страницы, подтверждающая факт"
        className="intel-fact-form__wide"
        data-intel-fact-evidence
      />
      <select
        value={value.verification}
        onChange={set('verification')}
        data-intel-fact-verification
      >
        {INTEL_VERIFICATION.map((v) => (
          <option key={v} value={v}>
            {VERIFICATION_LABEL[v]}
            {v === 'verified' ? ' — страница открыта, сущность на ней есть' : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function sourceKindLabel(f: IntelFact): string {
  if (f.ownSource) return 'собственный сайт';
  if (f.isProfileSource === true) return 'профильная площадка';
  if (f.isProfileSource === false) {
    return f.sourceType ? (SOURCE_TYPE_LABEL[f.sourceType] ?? 'непрофильный') : 'непрофильный';
  }
  return 'источник не разобран';
}

function FactLine({ f, showEntity }: { f: IntelFact; showEntity?: boolean }) {
  return (
    <div>
      {showEntity && f.entityName ? (
        <div>
          <Link to={`/intelligence/${f.entityId}`}>
            <strong>{f.entityName}</strong>
          </Link>
          {f.entityType ? <span className="muted small"> · {TYPE_LABEL[f.entityType]}</span> : null}
        </div>
      ) : null}
      <div>
        {f.role ? <strong>{f.role}</strong> : null}
        {f.organizationName ? (
          <>
            {f.role ? ' — ' : ''}
            <Link to={`/intelligence/${f.organizationId}`}>{f.organizationName}</Link>
          </>
        ) : null}
        {f.eventName ? (
          <>
            {' · '}
            <Link to={`/intelligence/${f.eventId}`}>{f.eventName}</Link>
          </>
        ) : null}
      </div>
      {f.action ? <div>{f.action}</div> : null}
      {f.evidence ? <div className="small muted">«{f.evidence}»</div> : null}
      <div className="small">
        <span className={VERIFICATION_BADGE[f.verification]}>
          {VERIFICATION_LABEL[f.verification]}
        </span>{' '}
        <Link to={`/intelligence/sources/${f.sourceId}`}>
          {f.sourceName ?? f.sourceDomain ?? f.sourceUrl}
        </Link>{' '}
        <span className="muted">· {sourceKindLabel(f)}</span>
      </div>
      {f.pageUrl ? (
        <div className="small">
          <a href={f.pageUrl} target="_blank" rel="noreferrer noopener">
            {f.pageUrl}
          </a>
        </div>
      ) : null}
    </div>
  );
}

// ========================================================= карточка сущности

export function IntelligenceCardPage() {
  const { id = '' } = useParams();
  const [card, setCard] = useState<IntelCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    try {
      setCard(await api.intelligence.card(id));
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Запись не загружена'));
    }
  }, [id]);

  useEffect(() => {
    setCard(null);
    setEditing(false);
    setNotice(null);
    void load();
  }, [load]);

  if (!card) {
    return (
      <div data-page="intelligence-card">
        <Link to="/intelligence" className="small">
          ← Сущности
        </Link>
        {error ? (
          <div className="alert alert--error">{error}</div>
        ) : (
          <div className="spinner">Загрузка…</div>
        )}
      </div>
    );
  }

  const e = card.entity;
  const m = card.metrics;
  const characteristics = (e.attributes.characteristics ?? {}) as Record<string, string[]>;
  const fullText = typeof e.attributes.text === 'string' ? e.attributes.text : null;
  const phone = typeof e.attributes.phone === 'string' ? e.attributes.phone : null;
  const merged = Array.isArray(e.attributes.merged)
    ? (e.attributes.merged as { id: string; name: string; mergedAt?: string }[])
    : [];

  async function mergeIn(dropId: string, dropName: string) {
    if (
      !window.confirm(
        `Объединить «${dropName}» в «${e.name}»? Факты, связи и ключи импорта переедут сюда, пустые поля дополнятся, а сведения дубля сохранятся в истории записи.`,
      )
    )
      return;
    try {
      setCard(await api.intelligence.merge(e.id, dropId));
      setNotice(`«${dropName}» объединена с этой записью.`);
    } catch (err) {
      setError(problemText(err, 'Записи не объединены'));
    }
  }

  return (
    <div data-page="intelligence-card">
      <Link to="/intelligence" className="small">
        ← Сущности
      </Link>
      <div className="page-head">
        <div>
          <h1>{e.name}</h1>
          <p className="page-hint">
            {TYPE_LABEL[e.type]}
            {e.organizationName ? ` · ${e.organizationName}` : ''}{' '}
            <span className={STATUS_BADGE[e.status]}>{STATUS_LABEL[e.status]}</span>
          </p>
        </div>
        <div className="row-actions">
          <select
            className="select--sm"
            value={e.status}
            aria-label="Статус"
            data-intel-card-status
            onChange={async (ev) => {
              try {
                setCard(
                  await api.intelligence.update(e.id, { status: ev.target.value as IntelStatus }),
                );
                setNotice('Статус изменён.');
              } catch (err) {
                setError(problemText(err, 'Статус не изменён'));
              }
            }}
          >
            {INTEL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn--ghost btn--sm"
            onClick={() => setEditing(!editing)}
            data-intel-edit
          >
            {editing ? 'Закрыть правку' : 'Редактировать'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}
      {card.duplicates.length > 0 ? (
        <div className="alert alert--info" data-intel-duplicates>
          Возможный дубль — тот же тип и то же имя без учёта кавычек и родовых слов, или та же
          ссылка источника:
          <ul style={{ margin: '6px 0 0' }}>
            {card.duplicates.map((d) => (
              <li key={d.id}>
                <Link to={`/intelligence/${d.id}`}>{d.name}</Link>{' '}
                <button
                  type="button"
                  className="btn--ghost btn--sm"
                  data-intel-merge={d.id}
                  onClick={() => void mergeIn(d.id, d.name)}
                >
                  Объединить сюда
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <section className="card" data-intel-metrics>
        <h2>Профильные показатели</h2>
        <div className="intel-metrics">
          <Metric
            value={m.uniqueProfileSources}
            label="профильных площадок"
            hint="Разных профильных площадок, где сущность подтверждённо замечена. Собственный сайт не в счёт."
          />
          <Metric value={m.profileFacts} label="профильных фактов" />
          <Metric
            value={m.mediaFacts}
            label="в СМИ и прочем"
            hint="Подтверждённые упоминания в непрофильных источниках: обогащают профиль, в вес не идут."
          />
          <Metric
            value={m.candidateFacts}
            label="кандидатов"
            hint="Не проверены, в показатели не идут."
          />
          <Metric value={dateLabel(m.firstProfileOn) ?? '—'} label="первое профильное появление" />
          <Metric
            value={dateLabel(m.lastProfileOn) ?? '—'}
            label="последнее профильное появление"
          />
        </div>
      </section>

      {card.roles.length > 0 ? (
        <section className="card" data-intel-roles>
          <h2>Роли</h2>
          <ul className="intel-roles">
            {card.roles.map((r) => (
              <li key={`${r.role}|${r.organizationId ?? ''}`}>
                <strong>{r.role}</strong>
                {r.organizationName ? (
                  <>
                    {' — '}
                    <Link to={`/intelligence/${r.organizationId}`}>{r.organizationName}</Link>
                  </>
                ) : null}
                <span className="muted small"> · фактов: {r.facts}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {editing ? (
        <section className="card">
          <h2>Правка</h2>
          <EntityForm
            initial={{
              type: e.type,
              name: e.name,
              organizationName: e.organizationName,
              description: e.description,
              websiteUrl: e.websiteUrl,
              email: e.email,
              telegram: e.telegram,
              linkedin: e.linkedin,
              status: e.status,
              notes: e.notes,
            }}
            submitLabel="Сохранить изменения"
            onCancel={() => setEditing(false)}
            onSubmit={async (input) => {
              setCard(await api.intelligence.update(e.id, input));
              setEditing(false);
              setNotice('Изменения сохранены.');
            }}
          />
        </section>
      ) : (
        <section className="card" data-intel-card>
          <h2>Основное</h2>
          <dl className="intel-dl">
            <DlRow title="Описание" value={<Pre text={e.description} />} />
            <DlRow title="Основная организация" value={e.organizationName ?? '—'} />
            <DlRow title="Сайт" value={e.websiteUrl ? <ExternalLink href={e.websiteUrl} /> : '—'} />
            <DlRow title="Email" value={e.email ?? '—'} />
            <DlRow title="Telegram" value={e.telegram ?? '—'} />
            <DlRow title="LinkedIn" value={e.linkedin ? <ExternalLink href={e.linkedin} /> : '—'} />
            {phone ? <DlRow title="Телефон" value={phone} /> : null}
            {Object.entries(characteristics).map(([title, values]) => (
              <DlRow key={title} title={title} value={values.join(', ')} />
            ))}
            <DlRow title="Впервые обнаружена" value={formatDate(e.createdAt)} />
            <DlRow title="Обновлена" value={formatDate(e.updatedAt)} />
            <DlRow title="Заметки" value={<Pre text={e.notes} />} />
          </dl>
          {fullText ? (
            <details>
              <summary className="small">Полный текст карточки источника</summary>
              <div className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {fullText}
              </div>
            </details>
          ) : null}
        </section>
      )}

      <FactsBlock card={card} onChanged={setCard} onError={setError} />

      {card.related.length > 0 ? (
        <section className="card" data-intel-related>
          <h2>Связи · {card.related.length}</h2>
          <p className="small muted">
            Факты других сущностей, где эта названа организацией или событием: партнёры фонда,
            участники Demo Day, члены клуба.
          </p>
          <ul className="intel-sources">
            {card.related.map((f) => (
              <li key={f.id}>
                <div className="intel-timeline__date small">
                  {dateLabel(f.happenedOn, f.happenedPrecision) ?? (
                    <span className="muted">без даты</span>
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <FactLine f={f} showEntity />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <OwnSourcesBlock card={card} onChanged={setCard} onError={setError} />

      {merged.length > 0 ? (
        <section className="card">
          <h2>Объединённые записи</h2>
          <ul className="small">
            {merged.map((d) => (
              <li key={d.id}>
                {d.name}{' '}
                {d.mergedAt ? <span className="muted">· {formatDate(d.mergedAt)}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Pre({ text }: { text: string | null }) {
  return <span style={{ whiteSpace: 'pre-wrap' }}>{text ?? '—'}</span>;
}

function Metric({ value, label, hint }: { value: number | string; label: string; hint?: string }) {
  return (
    <div className="intel-metric" title={hint}>
      <div className="intel-metric__value">{value}</div>
      <div className="small muted">{label}</div>
    </div>
  );
}

function DlRow({ title, value }: { title: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{title}</dt>
      <dd>{value}</dd>
    </>
  );
}

function ExternalLink({ href }: { href: string }) {
  const safe = /^https?:\/\//i.test(href) ? href : `https://${href}`;
  return (
    <a href={safe} target="_blank" rel="noreferrer noopener">
      {href}
    </a>
  );
}

/**
 * Хронология сущности (ТЗ-перестройка §7): факты по датам, новые сверху,
 * затем без даты; отклонённые скрыты по умолчанию. У каждого — источник,
 * профильный ли он, и статус проверки.
 */
function FactsBlock({
  card,
  onChanged,
  onError,
}: {
  card: IntelCard;
  onChanged: (card: IntelCard) => void;
  onError: (text: string) => void;
}) {
  const [adding, setAdding] = useState(emptyFact());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyFact());
  const [showRejected, setShowRejected] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onChanged(
        await api.intelligence.addFact(card.entity.id, {
          url: adding.url.trim(),
          ...factPayload(adding),
        }),
      );
      setAdding(emptyFact());
    } catch (err) {
      onError(problemText(err, 'Факт не добавлен'));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent, factId: string) {
    e.preventDefault();
    try {
      onChanged(await api.intelligence.updateFact(factId, factPayload(draft)));
      setEditing(null);
    } catch (err) {
      onError(problemText(err, 'Факт не сохранён'));
    }
  }

  async function remove(factId: string) {
    if (
      !window.confirm(
        'Удалить факт? Чтобы сохранить след проверки, лучше отметить его отклонённым.',
      )
    )
      return;
    try {
      await api.intelligence.removeFact(factId);
      onChanged(await api.intelligence.card(card.entity.id));
    } catch (err) {
      onError(problemText(err, 'Факт не удалён'));
    }
  }

  const rejected = card.facts.filter((f) => f.verification === 'rejected').length;
  const shown = card.facts.filter((f) => showRejected || f.verification !== 'rejected');

  return (
    <section className="card" data-intel-facts>
      <h2>Хронология · {card.facts.length - rejected}</h2>
      {card.facts.length === 0 ? <p className="muted small">Фактов пока нет.</p> : null}
      {rejected > 0 ? (
        <label className="small" style={{ display: 'flex', gap: 6, fontWeight: 400 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={showRejected}
            onChange={(e) => setShowRejected(e.target.checked)}
          />
          Показать отклонённые ({rejected})
        </label>
      ) : null}
      <ul className="intel-sources">
        {shown.map((f) => (
          <li key={f.id} data-intel-fact={f.id} data-intel-fact-status={f.verification}>
            <div className="intel-timeline__date small">
              {dateLabel(f.happenedOn, f.happenedPrecision) ?? (
                <span className="muted">без даты</span>
              )}
            </div>
            <div style={{ flex: 1 }}>
              {editing === f.id ? (
                <form onSubmit={(e) => void save(e, f.id)}>
                  <FactFields value={draft} onChange={setDraft} withUrl={false} />
                  <div
                    className="row-actions"
                    style={{ justifyContent: 'flex-start', marginTop: 6 }}
                  >
                    <button type="submit" className="btn--sm">
                      Сохранить
                    </button>
                    <button
                      type="button"
                      className="btn--ghost btn--sm"
                      onClick={() => setEditing(null)}
                    >
                      Отмена
                    </button>
                  </div>
                </form>
              ) : (
                <FactLine f={f} />
              )}
            </div>
            {editing === f.id ? null : (
              <div className="row-actions">
                <button
                  type="button"
                  className="btn--ghost btn--sm"
                  data-intel-fact-edit
                  onClick={() => {
                    setEditing(f.id);
                    setDraft(factState(f));
                  }}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="btn--danger btn--sm"
                  onClick={() => void remove(f.id)}
                >
                  Удалить
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} data-intel-fact-add>
        <h3 className="small" style={{ margin: '8px 0' }}>
          Новый факт
        </h3>
        <FactFields value={adding} onChange={setAdding} withUrl />
        <button type="submit" disabled={busy || !adding.url.trim()} style={{ marginTop: 6 }}>
          Добавить факт
        </button>
      </form>
    </section>
  );
}

function OwnSourcesBlock({
  card,
  onChanged,
  onError,
}: {
  card: IntelCard;
  onChanged: (card: IntelCard) => void;
  onError: (text: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const e = card.entity;

  async function make(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    try {
      onChanged(await api.intelligence.asSource(e.id, url.trim() || null));
      setUrl('');
    } catch (err) {
      onError(problemText(err, 'Источник не заведён'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-intel-own-sources>
      <h2>Собственные сайты и найденное от сущности</h2>
      <p className="small muted">
        Собственный сайт — источник сведений о сущности, но не независимое подтверждение: в её вес
        он не идёт. Здесь же источники, найденные обратным поиском от неё.
      </p>
      {card.ownSources.length > 0 ? (
        <ul className="intel-sources">
          {card.ownSources.map((s) => (
            <li key={s.id}>
              <div>
                <Link to={`/intelligence/sources/${s.id}`}>
                  <strong>{s.name ?? s.domain ?? s.url}</strong>
                </Link>
                <span className="muted small">
                  {' '}
                  · {s.representsEntityId === e.id ? 'собственный сайт' : 'найден от неё'} ·{' '}
                  {profileLabel(s.isProfile)}
                </span>
                <div className="small">{s.url}</div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={(ev) => void make(ev)} className="intel-filters">
        <input
          value={url}
          onChange={(ev) => setUrl(ev.target.value)}
          placeholder={
            e.websiteUrl ? `Адрес (по умолчанию сайт: ${e.websiteUrl})` : 'Адрес сайта: https://…'
          }
          data-intel-as-source-url
        />
        <button
          type="submit"
          className="btn--ghost"
          disabled={busy || (!url.trim() && !e.websiteUrl)}
          data-intel-as-source
        >
          Отметить собственным сайтом
        </button>
      </form>
    </section>
  );
}

// ========================================================= карточка источника

export function IntelligenceSourceCardPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [card, setCard] = useState<IntelSourceCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setCard(null);
    setEditing(false);
    api.intelligence
      .sourceCard(id)
      .then(setCard)
      .catch((err) => setError(problemText(err, 'Источник не загружен')));
  }, [id]);

  if (!card) {
    return (
      <div data-page="intelligence-source">
        <Link to="/intelligence/sources" className="small">
          ← Источники
        </Link>
        {error ? (
          <div className="alert alert--error">{error}</div>
        ) : (
          <div className="spinner">Загрузка…</div>
        )}
      </div>
    );
  }

  const s = card.source;

  async function remove() {
    if (!window.confirm('Удалить источник?')) return;
    try {
      await api.intelligence.removeSource(s.id);
      navigate('/intelligence/sources');
    } catch (err) {
      setError(problemText(err, 'Источник не удалён'));
    }
  }

  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'да' : 'нет');

  return (
    <div data-page="intelligence-source">
      <Link
        to={s.isProfile ? '/intelligence/platforms' : '/intelligence/sources'}
        className="small"
      >
        ← {s.isProfile ? 'Профильные площадки' : 'Источники'}
      </Link>
      <div className="page-head">
        <div>
          <h1>{s.name ?? s.domain ?? s.url}</h1>
          <p className="page-hint">
            <span
              className={
                s.isProfile === true
                  ? 'badge badge--ok'
                  : s.isProfile === false
                    ? 'badge badge--muted'
                    : 'badge badge--warn'
              }
            >
              {profileLabel(s.isProfile)}
            </span>{' '}
            {s.sourceType ? `${SOURCE_TYPE_LABEL[s.sourceType]} · ` : ''}
            площадка {SOURCE_VERIFICATION_LABEL[s.verification]} · достоверность:{' '}
            {RELIABILITY_LABEL[s.reliability]} · {DISCOVERY_LABEL[s.discovery]} · сущностей:{' '}
            <strong>{s.entityCount}</strong>
            {' · '}
            {weighs(s) ? 'даёт вес сущностям' : 'веса не даёт'}
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn--ghost btn--sm"
            onClick={() => setEditing(!editing)}
            data-intel-source-edit
          >
            {editing ? 'Закрыть правку' : 'Разобрать / править'}
          </button>
          {s.factCount === 0 ? (
            <button type="button" className="btn--danger btn--sm" onClick={() => void remove()}>
              Удалить
            </button>
          ) : null}
        </div>
      </div>
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {editing ? (
        <section className="card">
          <h2>Разбор источника</h2>
          <SourceForm
            initial={s}
            submitLabel="Сохранить"
            onCancel={() => setEditing(false)}
            onSubmit={async (input) => {
              setCard(await api.intelligence.updateSource(s.id, input));
              setEditing(false);
              setNotice('Изменения сохранены.');
            }}
          />
        </section>
      ) : (
        <section className="card" data-intel-source-card>
          <dl className="intel-dl">
            <DlRow title="Адрес" value={<ExternalLink href={s.url} />} />
            {s.title && s.title !== s.name ? (
              <DlRow title="Заголовок страницы" value={s.title} />
            ) : null}
            <DlRow title="Кратко" value={s.description ?? '—'} />
            <DlRow title="Что даёт" value={s.obtainable ?? '—'} />
            <DlRow title="Есть события" value={yesNo(s.hasEvents)} />
            <DlRow title="Есть списки участников" value={yesNo(s.hasParticipantLists)} />
            <DlRow title="Можно парсить" value={s.parseable ? PARSEABLE_LABEL[s.parseable] : '—'} />
            <DlRow
              title="Структурированность"
              value={s.structure ? LEVEL_LABEL[s.structure] : '—'}
            />
            <DlRow
              title="Публичные контакты"
              value={s.publicContacts ? CONTACTS_LABEL[s.publicContacts] : '—'}
            />
            <DlRow title="Сайт жив" value={s.alive ? ALIVE_LABEL[s.alive] : '—'} />
            <DlRow
              title="Приоритет парсера"
              value={s.parserPriority ? PRIORITY_LABEL[s.parserPriority] : '—'}
            />
            {s.viaEntityId ? (
              <DlRow
                title="Найден от сущности"
                value={<Link to={`/intelligence/${s.viaEntityId}`}>{s.viaEntityName}</Link>}
              />
            ) : null}
            {s.representsEntityId ? (
              <DlRow
                title="Собственный сайт сущности"
                value={
                  <Link to={`/intelligence/${s.representsEntityId}`}>{s.representsEntityName}</Link>
                }
              />
            ) : null}
            <DlRow title="Найден" value={formatDate(s.discoveredAt)} />
            <DlRow title="Проверен" value={s.lastCheckedAt ? formatDate(s.lastCheckedAt) : '—'} />
            <DlRow title="Заметки" value={<Pre text={s.notes} />} />
          </dl>
        </section>
      )}

      <section className="card" data-intel-source-facts>
        <h2>Факты из источника · {card.facts.length}</h2>
        {card.facts.length === 0 ? (
          <p className="muted small">
            Из источника ещё ничего не извлечено. Факт добавляется в карточке сущности —
            «Хронология».
          </p>
        ) : (
          <div className="intel-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Сущность</th>
                  <th>Роль</th>
                  <th>Когда</th>
                  <th>Проверка</th>
                  <th>Страница</th>
                </tr>
              </thead>
              <tbody>
                {card.facts.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <Link to={`/intelligence/${f.entityId}`}>{f.entityName}</Link>
                      {f.entityType ? (
                        <div className="small muted">{TYPE_LABEL[f.entityType]}</div>
                      ) : null}
                    </td>
                    <td className="small">
                      {f.role ?? '—'}
                      {f.organizationName ? ` — ${f.organizationName}` : ''}
                    </td>
                    <td className="small">{dateLabel(f.happenedOn, f.happenedPrecision) ?? '—'}</td>
                    <td className="small">
                      <span className={VERIFICATION_BADGE[f.verification]}>
                        {VERIFICATION_LABEL[f.verification]}
                      </span>
                    </td>
                    <td className="small">
                      {f.pageUrl ? (
                        <a href={f.pageUrl} target="_blank" rel="noreferrer noopener">
                          открыть
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
