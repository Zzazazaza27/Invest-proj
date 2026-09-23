import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  INTEL_STATUSES,
  INTEL_TYPES,
  type IntelCard,
  type IntelEntityInput,
  type IntelRow,
  type IntelSource,
  type IntelStatus,
  type IntelType,
} from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Market Intelligence (M137) — склад сведений об инвестиционном рынке.
 *
 * Постановка — docs/product/market-intelligence/ТЗ-MVP.md. Намеренно одна
 * таблица и карточка: ни дашбордов, ни воронки (ТЗ §3, §13). Сортировка и
 * фильтры по типу и статусу — на клиенте поверх выборки: записей сотни, а не
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

type SortKey = 'type' | 'name' | 'organizationName' | 'source' | 'contact' | 'status' | 'updatedAt';

function contactOf(row: IntelRow): string {
  const kinds = [
    row.telegram && 'Telegram',
    row.email && 'Email',
    row.linkedin && 'LinkedIn',
    row.websiteUrl && 'Сайт',
  ].filter(Boolean);
  return kinds.join(', ');
}

// =================================================================== список

export function IntelligencePage() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<IntelRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [type, setType] = useState<string>('');
  const [status, setStatus] = useState<string>('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'updatedAt', dir: -1 });
  const [panel, setPanel] = useState<'none' | 'add' | 'url'>('none');
  const [view, setView] = useState<'entities' | 'sources'>('entities');
  const [importing, setImporting] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await api.intelligence.list({});
      setRows(list.items);
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
    const filtered = rows.filter(
      (r) =>
        (!type || r.type === type) &&
        (!status || r.status === status) &&
        (!needle ||
          [r.name, r.organizationName, r.description, r.email, r.notes, r.sourceDomains]
            .filter(Boolean)
            .some((v) => v!.toLowerCase().includes(needle))),
    );
    const value = (r: IntelRow): string => {
      switch (sort.key) {
        case 'type':
          return TYPE_LABEL[r.type];
        case 'status':
          return String(INTEL_STATUSES.indexOf(r.status));
        case 'source':
          return r.sourceDomains ?? '';
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
    return [...filtered].sort((a, b) => value(a).localeCompare(value(b), 'ru') * sort.dir);
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
      setNotice(`Импорт get-investor.ru завершён. ${lines.join('; ')}.`);
      await load();
    } catch (err) {
      setError(problemText(err, 'Импорт не выполнен'));
    } finally {
      setImporting(false);
    }
  }

  const header = (key: SortKey, label: string) => (
    <th>
      <button
        type="button"
        className="intel-sort"
        onClick={() =>
          setSort((s) => ({
            key,
            dir: s.key === key ? (-s.dir as 1 | -1) : key === 'updatedAt' ? -1 : 1,
          }))
        }
      >
        {label}
        {sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );

  return (
    <div data-page="intelligence">
      <div className="page-head">
        <div>
          <h1>Market Intelligence</h1>
          <p className="page-hint">
            Сведения об участниках инвестиционного рынка и источники, где они найдены. Склад, а не
            CRM: сначала копим данные, потом по ним уточняем модель.
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            data-intel-add
            onClick={() => setPanel(panel === 'add' ? 'none' : 'add')}
          >
            Добавить запись
          </button>
          <button
            type="button"
            className="btn--ghost"
            data-intel-import-url
            onClick={() => setPanel(panel === 'url' ? 'none' : 'url')}
          >
            Импорт URL
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
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {panel === 'add' ? (
        <section className="card">
          <h2>Новая запись</h2>
          <EntityForm
            withSource
            submitLabel="Сохранить"
            onCancel={() => setPanel('none')}
            onSubmit={async (input) => {
              const card = await api.intelligence.create(input);
              setPanel('none');
              navigate(`/intelligence/${card.entity.id}`, {
                state: { duplicates: card.duplicates.length },
              });
            }}
          />
        </section>
      ) : null}

      {panel === 'url' ? (
        <ImportUrlPanel
          onDone={async (text) => {
            setNotice(text);
            setPanel('none');
            setView('sources');
          }}
        />
      ) : null}

      <div className="intel-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'entities'}
          className={view === 'entities' ? '' : 'btn--ghost'}
          onClick={() => setView('entities')}
        >
          Сущности{rows ? ` · ${rows.length}` : ''}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'sources'}
          className={view === 'sources' ? '' : 'btn--ghost'}
          onClick={() => setView('sources')}
        >
          Источники
        </button>
      </div>

      {view === 'sources' ? (
        <SourcesList />
      ) : (
        <section className="card">
          <div className="intel-filters">
            <input
              type="search"
              placeholder="Поиск: имя, организация, описание, почта, заметки, домен"
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
              Записей пока нет. Добавьте первую вручную или запустите импорт get-investor.ru.
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
                      {header('source', 'Источник')}
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
                        <td className="small">{r.sourceDomains ?? '—'}</td>
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
      )}
    </div>
  );
}

// ============================================================ форма записи

const emptyInput = (): IntelEntityInput & { sourceUrl: string } => ({
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
  const [form, setForm] = useState({ ...emptyInput(), ...initial });
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
          <select value={form.type} onChange={set('type')}>
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
          <label>Где найдено (URL источника)</label>
          <input
            value={form.sourceUrl}
            onChange={set('sourceUrl')}
            placeholder="https://…"
            name="sourceUrl"
          />
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
      <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
        <button type="submit" disabled={busy || !form.name.trim()}>
          {busy ? 'Сохраняем…' : submitLabel}
        </button>
        {onCancel ? (
          <button type="button" className="btn--ghost" onClick={onCancel}>
            Отмена
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ============================================================== импорт URL

function ImportUrlPanel({ onDone }: { onDone: (text: string) => Promise<void> }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.intelligence.importUrl({ url: url.trim() });
      await onDone(
        result.fetched
          ? `Источник сохранён: ${result.source.title ?? result.source.url}.`
          : `Адрес сохранён, но страница не получена. ${result.problem ?? ''}`,
      );
    } catch (err) {
      setError(problemText(err, 'Источник не сохранён'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Импорт URL</h2>
      <p className="small muted">
        Страница сохраняется как источник: адрес, домен, заголовок и дата. Разобрать её на записи —
        дело человека; адрес сохранится, даже если страница сейчас не открывается.
      </p>
      {error && <div className="alert alert--error">{error}</div>}
      <form onSubmit={(e) => void submit(e)} className="intel-filters">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://…"
          required
          data-intel-url
        />
        <button type="submit" disabled={busy || !url.trim()}>
          {busy ? 'Загружаем…' : 'Сохранить источник'}
        </button>
      </form>
    </section>
  );
}

// ============================================================ источники

function SourcesList() {
  const [items, setItems] = useState<IntelSource[] | null>(null);
  const [loose, setLoose] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    api.intelligence
      .sources(loose)
      .then((list) => setItems(list.items))
      .catch((err) => setError(problemText(err, 'Не удалось загрузить источники')));
  }, [loose]);

  return (
    <section className="card" data-intel-sources>
      <label
        className="small"
        style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}
      >
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={loose}
          onChange={(e) => setLoose(e.target.checked)}
        />
        Только не привязанные к записям (сохранённые через «Импорт URL»)
      </label>
      {error && <div className="alert alert--error">{error}</div>}
      {items === null ? (
        <div className="spinner">Загрузка…</div>
      ) : items.length === 0 ? (
        <p className="muted">Источников нет.</p>
      ) : (
        <div className="intel-table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Домен</th>
                <th>Заголовок / адрес</th>
                <th>Запись</th>
                <th>Найдено</th>
                <th>Проверено</th>
              </tr>
            </thead>
            <tbody>
              {items.map((s) => (
                <tr key={s.id}>
                  <td className="small">{s.domain ?? '—'}</td>
                  <td>
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      {s.title ?? s.url}
                    </a>
                    {s.notes ? <div className="small muted">{s.notes}</div> : null}
                  </td>
                  <td className="small">
                    {s.entityId ? (
                      <Link to={`/intelligence/${s.entityId}`}>{s.entityName}</Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="small muted">{formatDate(s.discoveredAt)}</td>
                  <td className="small muted">
                    {s.lastCheckedAt ? formatDate(s.lastCheckedAt) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ================================================================ карточка

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
    void load();
  }, [load]);

  if (!card) {
    return (
      <div data-page="intelligence-card">
        <Link to="/intelligence" className="small">
          ← Market Intelligence
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

  return (
    <div data-page="intelligence-card">
      <Link to="/intelligence" className="small">
        ← Market Intelligence
      </Link>
      <div className="page-head">
        <div>
          <h1>{e.name}</h1>
          <p className="page-hint">
            {TYPE_LABEL[e.type]}
            {e.organizationName ? ` · ${e.organizationName}` : ''} ·{' '}
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
              <FragmentRow key={title} title={title} value={values.join(', ')} />
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

      <SourcesBlock card={card} onChanged={setCard} onError={setError} />

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

function FragmentRow({ title, value }: { title: string; value: string }) {
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

function SourcesBlock({
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

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onChanged(await api.intelligence.addSource(card.entity.id, { url: url.trim() }));
      setUrl('');
    } catch (err) {
      onError(problemText(err, 'Источник не добавлен'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(source: IntelSource) {
    if (!window.confirm(`Убрать источник ${source.url}?`)) return;
    try {
      await api.intelligence.removeSource(source.id);
      onChanged(await api.intelligence.card(card.entity.id));
    } catch (err) {
      onError(problemText(err, 'Источник не удалён'));
    }
  }

  return (
    <section className="card" data-intel-card-sources>
      <h2>Источники · {card.sources.length}</h2>
      {card.sources.length === 0 ? <p className="muted small">Источников пока нет.</p> : null}
      <ul className="intel-sources">
        {card.sources.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.title ?? s.domain ?? 'Источник'}</strong>
              <div className="small">
                <a href={s.url} target="_blank" rel="noreferrer noopener">
                  {s.url}
                </a>
              </div>
              <div className="small muted">
                найдено {formatDate(s.discoveredAt)}
                {s.lastCheckedAt ? ` · проверено ${formatDate(s.lastCheckedAt)}` : ''}
              </div>
            </div>
            <button type="button" className="btn--danger btn--sm" onClick={() => void remove(s)}>
              Убрать
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} className="intel-filters">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Ещё один источник: https://…"
          data-intel-source-url
        />
        <button type="submit" disabled={busy || !url.trim()}>
          Добавить источник
        </button>
      </form>
    </section>
  );
}
