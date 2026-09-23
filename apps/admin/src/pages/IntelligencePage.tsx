import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  INTEL_ALIVE,
  INTEL_CONTACTS,
  INTEL_DISCOVERY,
  INTEL_LEVELS,
  INTEL_STATUSES,
  INTEL_TYPES,
  type IntelCard,
  type IntelEntityInput,
  type IntelMention,
  type IntelMentionInput,
  type IntelRow,
  type IntelSource,
  type IntelSourceCard,
  type IntelSourceInput,
  type IntelStatus,
  type IntelType,
} from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Market Intelligence (M137, M139) — сведения об инвестиционном рынке.
 *
 * Постановка — docs/product/market-intelligence/ТЗ-MVP.md. Три понятия:
 * СУЩНОСТЬ (участник рынка), ИСТОЧНИК (сайт или страница, где участники
 * собраны) и УПОМИНАНИЕ (сущность найдена в источнике). «Встречается» у
 * сущности — число разных источников с её упоминанием: по нему видно, кто
 * на рынке заметнее.
 *
 * Сортировка и фильтры — на клиенте поверх выборки: записей сотни, не
 * миллионы, и так экран отвечает мгновенно.
 */

export const TYPE_LABEL: Record<IntelType, string> = {
  person: 'Человек',
  investor: 'Инвестор',
  organization: 'Организация',
  fund: 'Фонд',
  investor_club: 'Клуб инвесторов',
  accelerator: 'Акселератор',
  bootcamp: 'Буткемп',
  event: 'Мероприятие',
  media: 'Медиа',
  corporation: 'Корпорация',
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

const LEVEL_LABEL: Record<string, string> = { high: 'высокая', medium: 'средняя', low: 'низкая' };
const PRIORITY_LABEL: Record<string, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' };
const CONTACTS_LABEL: Record<string, string> = { yes: 'есть', partial: 'частично', no: 'нет' };
const ALIVE_LABEL: Record<string, string> = { yes: 'да', no: 'нет', unknown: 'не проверен' };
const DISCOVERY_LABEL: Record<string, string> = {
  direct: 'прямой поиск',
  reverse: 'обратный поиск',
  import: 'импорт',
  manual: 'вручную',
};

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

/** Сортировка по заголовку колонки: повторный щелчок меняет направление. */
function useSort<K extends string>(initial: K, initialDir: 1 | -1 = 1) {
  const [sort, setSort] = useState<{ key: K; dir: 1 | -1 }>({ key: initial, dir: initialDir });
  const header = (key: K, label: string, numeric = false) => (
    <th>
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
  return (
    <div data-page="intelligence">
      <div className="page-head">
        <div>
          <h1>Market Intelligence</h1>
          <p className="page-hint">
            Участники инвестиционного рынка, источники, где они собраны, и упоминания — кто где
            найден. Чем в большем числе источников встречается сущность, тем она заметнее.
          </p>
        </div>
        {actions ? <div className="row-actions">{actions}</div> : null}
      </div>
      <div className="intel-tabs">
        <NavLink
          end
          to="/intelligence"
          className={({ isActive }) => `intel-tab${isActive ? ' intel-tab--active' : ''}`}
        >
          Сущности
        </NavLink>
        <NavLink
          to="/intelligence/sources"
          className={({ isActive }) => `intel-tab${isActive ? ' intel-tab--active' : ''}`}
        >
          Источники
        </NavLink>
      </div>
      {children}
    </div>
  );
}

// ============================================================ сущности

type EntitySortKey =
  'type' | 'name' | 'organizationName' | 'sourceCount' | 'contact' | 'status' | 'updatedAt';

export function IntelligencePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const { sort, header } = useSort<EntitySortKey>('updatedAt', -1);
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
        case 'sourceCount':
          return r.sourceCount;
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
            [r.name, r.organizationName, r.description, r.email, r.notes, r.sourceNames]
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
            placeholder="Поиск: имя, организация, описание, почта, заметки, источник"
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
                    {header('sourceCount', 'Встречается', true)}
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
                            title="Есть запись с тем же именем и организацией или той же ссылкой"
                          >
                            дубль?
                          </span>
                        ) : null}
                      </td>
                      <td className="small">{r.organizationName ?? '—'}</td>
                      <td className="small" title={r.sourceNames ?? ''}>
                        <strong>{r.sourceCount}</strong>
                        {r.sourceNames ? <span className="muted"> · {r.sourceNames}</span> : null}
                      </td>
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
  'name' | 'kind' | 'discovery' | 'structure' | 'parserPriority' | 'mentionCount' | 'updatedAt';

const LEVEL_ORDER: Record<string, number> = { high: 3, medium: 2, low: 1 };

export function IntelligenceSourcesPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<IntelSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [discovery, setDiscovery] = useState('');
  const [priority, setPriority] = useState('');
  const { sort, header } = useSort<SourceSortKey>('mentionCount', -1);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
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
        case 'kind':
          return s.kind ?? '';
        case 'discovery':
          return DISCOVERY_LABEL[s.discovery] ?? s.discovery;
        case 'structure':
          return LEVEL_ORDER[s.structure ?? ''] ?? 0;
        case 'parserPriority':
          return LEVEL_ORDER[s.parserPriority ?? ''] ?? 0;
        case 'mentionCount':
          return s.mentionCount;
        case 'updatedAt':
          return s.updatedAt;
        default:
          return s.name ?? s.domain ?? s.url;
      }
    };
    return items
      .filter(
        (s) =>
          (!discovery || s.discovery === discovery) &&
          (!priority || s.parserPriority === priority) &&
          (!needle ||
            [s.name, s.url, s.kind, s.description, s.obtainable, s.notes, s.viaEntityName]
              .filter(Boolean)
              .some((v) => v!.toLowerCase().includes(needle))),
      )
      .sort((a, b) => compare(value(a), value(b)) * sort.dir);
  }, [items, q, discovery, priority, sort]);

  return (
    <Shell
      actions={
        <button type="button" data-intel-source-add onClick={() => setAdding(!adding)}>
          Добавить источник
        </button>
      }
    >
      {error && <div className="alert alert--error">{error}</div>}
      {adding ? (
        <section className="card">
          <h2>Новый источник</h2>
          <p className="small muted">
            Сайт или страница, где собраны участники рынка. Страница загружается, чтобы взять
            заголовок; адрес сохраняется, даже если она сейчас не открывается. Адреса внутренней
            сети сервер не загружает.
          </p>
          <SourceForm
            submitLabel="Сохранить источник"
            onCancel={() => setAdding(false)}
            onSubmit={async (input) => {
              const created = await api.intelligence.createSource(input);
              navigate(`/intelligence/sources/${created.source.id}`, {
                state: { problem: created.problem },
              });
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
          <select value={discovery} onChange={(e) => setDiscovery(e.target.value)}>
            <option value="">Как найден — любой</option>
            {INTEL_DISCOVERY.map((d) => (
              <option key={d} value={d}>
                {DISCOVERY_LABEL[d]}
              </option>
            ))}
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
        ) : items.length === 0 ? (
          <p className="muted">Источников пока нет.</p>
        ) : (
          <>
            <div className="small muted" style={{ marginBottom: 6 }}>
              Показано {visible.length} из {items.length}
            </div>
            <div className="intel-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {header('name', 'Источник')}
                    {header('kind', 'Тип')}
                    {header('discovery', 'Как найден')}
                    {header('structure', 'Структура', true)}
                    {header('parserPriority', 'Парсер', true)}
                    {header('mentionCount', 'Сущностей', true)}
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
                        <div className="small muted">{s.domain ?? s.url}</div>
                      </td>
                      <td className="small">{s.kind ?? '—'}</td>
                      <td className="small">
                        {DISCOVERY_LABEL[s.discovery]}
                        {s.viaEntityName ? (
                          <div className="muted">от: {s.viaEntityName}</div>
                        ) : null}
                        {s.representsEntityName ? (
                          <div className="muted">это: {s.representsEntityName}</div>
                        ) : null}
                      </td>
                      <td className="small">{s.structure ? LEVEL_LABEL[s.structure] : '—'}</td>
                      <td className="small">
                        {s.parserPriority ? (
                          <span
                            className={
                              s.parserPriority === 'high' ? 'badge badge--ok' : 'badge badge--muted'
                            }
                          >
                            {PRIORITY_LABEL[s.parserPriority]}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="small">
                        <strong>{s.mentionCount}</strong>
                      </td>
                      <td className="small muted">
                        {new Date(s.updatedAt).toLocaleDateString('ru-RU')}
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

// ========================================================== форма сущности

const emptyEntity = (): IntelEntityInput & { sourceUrl: string } => ({
  type: 'investor',
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
        </div>
        <div className="field">
          <label>Название / имя *</label>
          <input value={form.name} onChange={set('name')} required maxLength={300} name="name" />
        </div>
        <div className="field">
          <label>Организация</label>
          <input
            value={form.organizationName ?? ''}
            onChange={set('organizationName')}
            maxLength={300}
            name="organizationName"
          />
        </div>
      </div>
      <div className="field">
        <label>Описание</label>
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
            Страница станет упоминанием в источнике того же сайта; если такого источника нет, он
            будет заведён.
          </div>
        </div>
      ) : null}
      <div className="grid-3">
        <div className="field">
          <label>Статус</label>
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

type SourceFormState = Required<{ [K in keyof IntelSourceInput]: string }>;

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
      await onSubmit({ ...form, url: form.url.trim() });
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
        <div className="field">
          <label>Тип источника</label>
          <input
            value={form.kind}
            onChange={set('kind')}
            placeholder="каталог, клуб, медиа, мероприятие…"
          />
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
      <div className="field">
        <label>Кратко</label>
        <textarea rows={2} value={form.description} onChange={set('description')} />
      </div>
      <div className="field">
        <label>Какие сущности можно получить</label>
        <input value={form.obtainable} onChange={set('obtainable')} />
      </div>
      <div className="grid-3">
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
  const characteristics = (e.attributes.characteristics ?? {}) as Record<string, string[]>;
  const fullText = typeof e.attributes.text === 'string' ? e.attributes.text : null;
  const phone = typeof e.attributes.phone === 'string' ? e.attributes.phone : null;
  const distinctSources = new Set(card.mentions.map((m) => m.sourceDomain ?? m.sourceId)).size;

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
            {e.organizationName ? ` · ${e.organizationName}` : ''} · встречается на{' '}
            <strong>{distinctSources}</strong> сайтах{' '}
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
          Возможный дубль — та же ссылка источника или те же имя и организация:{' '}
          {card.duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 ? ', ' : ''}
              <Link to={`/intelligence/${d.id}`}>{d.name}</Link>
            </span>
          ))}
          . Записи автоматически не объединяются.
        </div>
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
            <dt>Описание</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{e.description ?? '—'}</dd>
            <dt>Сайт</dt>
            <dd>{e.websiteUrl ? <ExternalLink href={e.websiteUrl} /> : '—'}</dd>
            <dt>Email</dt>
            <dd>{e.email ?? '—'}</dd>
            <dt>Telegram</dt>
            <dd>{e.telegram ?? '—'}</dd>
            <dt>LinkedIn</dt>
            <dd>{e.linkedin ? <ExternalLink href={e.linkedin} /> : '—'}</dd>
            {phone ? (
              <>
                <dt>Телефон</dt>
                <dd>{phone}</dd>
              </>
            ) : null}
            {Object.entries(characteristics).map(([title, values]) => (
              <DlRow key={title} title={title} value={values.join(', ')} />
            ))}
            <dt>Заметки</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{e.notes ?? '—'}</dd>
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

      <MentionsBlock card={card} onChanged={setCard} onError={setError} />
      <OwnSourcesBlock card={card} onChanged={setCard} onError={setError} />

      <section className="card">
        <h2>История</h2>
        <dl className="intel-dl">
          <dt>Создано</dt>
          <dd>{formatDate(e.createdAt)}</dd>
          <dt>Последнее изменение</dt>
          <dd>{formatDate(e.updatedAt)}</dd>
          {e.importSource ? (
            <>
              <dt>Импорт</dt>
              <dd>
                {e.importSource}
                {e.importedAt ? ` · ${formatDate(e.importedAt)}` : ''}
                {e.externalId ? ` · № ${e.externalId}` : ''}
              </dd>
            </>
          ) : null}
        </dl>
      </section>
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

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Дата события с той точностью, с какой она известна. */
function happenedLabel(m: IntelMention): string | null {
  if (!m.happenedOn) return null;
  const [y, mo, d] = m.happenedOn.split('-');
  if (m.happenedPrecision === 'year') return y!;
  if (m.happenedPrecision === 'month') return `${MONTHS[Number(mo) - 1]} ${y}`;
  return `${d}.${mo}.${y}`;
}

type TimelineState = {
  context: string;
  summary: string;
  happenedOn: string;
  happenedPrecision: 'day' | 'month' | 'year';
};

/** Поля хроники: роль, что делал, когда. Одинаковы при добавлении и правке. */
function TimelineFields({
  value,
  onChange,
}: {
  value: TimelineState;
  onChange: (next: TimelineState) => void;
}) {
  const set = (key: keyof TimelineState) => (e: { target: { value: string } }) =>
    onChange({ ...value, [key]: e.target.value });
  return (
    <>
      <input
        value={value.context}
        onChange={set('context')}
        placeholder="Роль: спикер, жюри, инвестор раунда…"
        style={{ flex: '1 1 200px' }}
        data-intel-mention-context
      />
      <input
        type="date"
        value={value.happenedOn}
        onChange={set('happenedOn')}
        style={{ flex: '0 1 160px' }}
        aria-label="Когда было"
        data-intel-mention-date
      />
      <select
        value={value.happenedPrecision}
        onChange={set('happenedPrecision')}
        style={{ flex: '0 1 120px' }}
        aria-label="Точность даты"
      >
        <option value="day">день</option>
        <option value="month">месяц</option>
        <option value="year">год</option>
      </select>
      <input
        value={value.summary}
        onChange={set('summary')}
        placeholder="Что делал: выступил про…, вложился в…, дал интервью о…"
        style={{ flex: '1 1 100%' }}
        data-intel-mention-summary
      />
    </>
  );
}

const emptyTimeline = (): TimelineState => ({
  context: '',
  summary: '',
  happenedOn: '',
  happenedPrecision: 'day',
});

const timelinePayload = (v: TimelineState): IntelMentionInput => ({
  context: v.context.trim() || null,
  summary: v.summary.trim() || null,
  happenedOn: v.happenedOn || null,
  happenedPrecision: v.happenedOn ? v.happenedPrecision : null,
});

/**
 * Профиль сущности: хроника упоминаний.
 *
 * Сначала датированные события — новые сверху, затем найденное без даты. По
 * этой ленте видно, кто это и что делал, — основа для адресного письма.
 */
function MentionsBlock({
  card,
  onChanged,
  onError,
}: {
  card: IntelCard;
  onChanged: (card: IntelCard) => void;
  onError: (text: string) => void;
}) {
  const [url, setUrl] = useState('');
  const [fields, setFields] = useState(emptyTimeline());
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyTimeline());

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onChanged(
        await api.intelligence.addMention(card.entity.id, {
          url: url.trim(),
          ...timelinePayload(fields),
        }),
      );
      setUrl('');
      setFields(emptyTimeline());
    } catch (err) {
      onError(problemText(err, 'Упоминание не добавлено'));
    } finally {
      setBusy(false);
    }
  }

  async function save(e: React.FormEvent, mentionId: string) {
    e.preventDefault();
    try {
      onChanged(await api.intelligence.updateMention(mentionId, timelinePayload(draft)));
      setEditing(null);
    } catch (err) {
      onError(problemText(err, 'Упоминание не сохранено'));
    }
  }

  async function remove(mentionId: string, label: string) {
    if (!window.confirm(`Убрать упоминание: ${label}?`)) return;
    try {
      await api.intelligence.removeMention(mentionId);
      onChanged(await api.intelligence.card(card.entity.id));
    } catch (err) {
      onError(problemText(err, 'Упоминание не удалено'));
    }
  }

  const sources = new Set(card.mentions.map((m) => m.sourceDomain ?? m.sourceId)).size;

  return (
    <section className="card" data-intel-mentions>
      <h2>
        Профиль: где упоминается и что делал · {card.mentions.length}
        <span className="small muted" style={{ fontWeight: 400 }}>
          {' '}
          (сайтов: {sources})
        </span>
      </h2>
      {card.mentions.length === 0 ? <p className="muted small">Упоминаний пока нет.</p> : null}
      <ul className="intel-sources">
        {card.mentions.map((m) => (
          <li key={m.id} data-intel-mention={m.id}>
            <div className="intel-timeline__date small">
              {happenedLabel(m) ?? <span className="muted">без даты</span>}
            </div>
            <div style={{ flex: 1 }}>
              {editing === m.id ? (
                <form onSubmit={(e) => void save(e, m.id)} className="intel-filters">
                  <TimelineFields value={draft} onChange={setDraft} />
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
                </form>
              ) : (
                <>
                  {m.summary ? <div>{m.summary}</div> : null}
                  <div className={m.summary ? 'small' : ''}>
                    <Link to={`/intelligence/sources/${m.sourceId}`}>
                      <strong>{m.sourceName ?? m.sourceDomain ?? m.sourceUrl}</strong>
                    </Link>
                    {m.context ? <span className="muted"> · {m.context}</span> : null}
                  </div>
                  {m.pageUrl ? (
                    <div className="small">
                      <a href={m.pageUrl} target="_blank" rel="noreferrer noopener">
                        {m.pageUrl}
                      </a>
                    </div>
                  ) : null}
                  <div className="small muted">
                    найдено {formatDate(m.foundAt)}
                    {m.lastCheckedAt ? ` · проверено ${formatDate(m.lastCheckedAt)}` : ''}
                  </div>
                </>
              )}
            </div>
            {editing === m.id ? null : (
              <div className="row-actions">
                <button
                  type="button"
                  className="btn--ghost btn--sm"
                  data-intel-mention-edit
                  onClick={() => {
                    setEditing(m.id);
                    setDraft({
                      context: m.context ?? '',
                      summary: m.summary ?? '',
                      happenedOn: m.happenedOn ?? '',
                      happenedPrecision: m.happenedPrecision ?? 'day',
                    });
                  }}
                >
                  Изменить
                </button>
                <button
                  type="button"
                  className="btn--danger btn--sm"
                  onClick={() => void remove(m.id, m.pageUrl ?? m.sourceUrl)}
                >
                  Убрать
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} className="intel-filters">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Где ещё найдено: https://…"
          style={{ flex: '1 1 100%' }}
          data-intel-mention-url
        />
        <TimelineFields value={fields} onChange={setFields} />
        <button type="submit" disabled={busy || !url.trim()}>
          Добавить упоминание
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
      <h2>Сущность как источник</h2>
      <p className="small muted">
        Сайт фонда с портфелем, страница клуба с участниками, мероприятие со спикерами — сама
        сущность становится местом, где искать другие. Здесь же источники, найденные обратным
        поиском от этой сущности.
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
                  · {s.representsEntityId === e.id ? 'это сама сущность' : 'найден от неё'} ·
                  сущностей в нём: {s.mentionCount}
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
            e.websiteUrl
              ? `Адрес (по умолчанию сайт: ${e.websiteUrl})`
              : 'Адрес страницы: https://…'
          }
          data-intel-as-source-url
        />
        <button
          type="submit"
          className="btn--ghost"
          disabled={busy || (!url.trim() && !e.websiteUrl)}
          data-intel-as-source
        >
          Сделать источником
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

  return (
    <div data-page="intelligence-source">
      <Link to="/intelligence/sources" className="small">
        ← Источники
      </Link>
      <div className="page-head">
        <div>
          <h1>{s.name ?? s.domain ?? s.url}</h1>
          <p className="page-hint">
            {s.kind ? `${s.kind} · ` : ''}
            {DISCOVERY_LABEL[s.discovery]} · сущностей: <strong>{s.mentionCount}</strong>
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn--ghost btn--sm"
            onClick={() => setEditing(!editing)}
            data-intel-source-edit
          >
            {editing ? 'Закрыть правку' : 'Редактировать'}
          </button>
          {s.mentionCount === 0 ? (
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
          <h2>Правка</h2>
          <SourceForm
            initial={s}
            submitLabel="Сохранить изменения"
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
            <DlRow title="Какие сущности даёт" value={s.obtainable ?? '—'} />
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
                title="Это сама сущность"
                value={
                  <Link to={`/intelligence/${s.representsEntityId}`}>{s.representsEntityName}</Link>
                }
              />
            ) : null}
            <DlRow title="Найден" value={formatDate(s.discoveredAt)} />
            <DlRow title="Проверен" value={s.lastCheckedAt ? formatDate(s.lastCheckedAt) : '—'} />
            <DlRow
              title="Заметки"
              value={<span style={{ whiteSpace: 'pre-wrap' }}>{s.notes ?? '—'}</span>}
            />
          </dl>
        </section>
      )}

      <section className="card" data-intel-source-mentions>
        <h2>Сущности в источнике · {card.mentions.length}</h2>
        {card.mentions.length === 0 ? (
          <p className="muted small">
            Сущности из источника ещё не извлечены. Добавить упоминание можно из карточки сущности:
            «Где найдено».
          </p>
        ) : (
          <div className="intel-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Сущность</th>
                  <th>Тип</th>
                  <th>Роль / раздел</th>
                  <th>Страница</th>
                </tr>
              </thead>
              <tbody>
                {card.mentions.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link to={`/intelligence/${m.entityId}`}>{m.entityName}</Link>
                    </td>
                    <td className="small">{TYPE_LABEL[m.entityType]}</td>
                    <td className="small">{m.context ?? '—'}</td>
                    <td className="small">
                      {m.pageUrl ? (
                        <a href={m.pageUrl} target="_blank" rel="noreferrer noopener">
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
