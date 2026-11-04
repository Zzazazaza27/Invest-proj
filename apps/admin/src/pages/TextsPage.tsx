import { useCallback, useEffect, useState } from 'react';
import {
  TEXT_FIELDS,
  type Language,
  type TextEntry,
  type TextNamespace,
  type TextVersion,
} from '@fifth/contracts';
import { Markdown, PromptDialog } from '@fifth/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Словарь терминов и ЧАВО (этап 5.3, план 0.2 §2.6).
 *
 * Запись — стабильный ключ, порядок и активность; текст каждого поля на
 * каждом языке — версия с основанием. Правка публикуется новой версией,
 * прежняя остаётся в истории. Пустое поле — «перевода нет»: основателю
 * отдаётся запасной язык, а здесь виден пропуск.
 */

const NAMESPACES: { key: TextNamespace; title: string; hint: string }[] = [
  {
    key: 'glossary',
    title: 'Словарь терминов',
    hint: 'Термин, короткое пояснение для подсказки рядом с термином и полная статья для страницы словаря.',
  },
  {
    key: 'faq',
    title: 'ЧАВО',
    hint: 'Вопрос и ответ для страницы вопросов и ответов в кабинете основателя.',
  },
];

const FIELD_LABEL: Record<string, { label: string; multiline: boolean }> = {
  term: { label: 'Термин', multiline: false },
  short_md: { label: 'Короткое пояснение (Markdown, для подсказки)', multiline: true },
  full_md: { label: 'Полная статья (Markdown)', multiline: true },
  question: { label: 'Вопрос', multiline: false },
  answer_md: { label: 'Ответ (Markdown)', multiline: true },
};

export function TextsPage() {
  const [namespace, setNamespace] = useState<TextNamespace>('glossary');
  const [languages, setLanguages] = useState<Language[]>([]);
  const [items, setItems] = useState<TextEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: string; draft: TextEntry } | null>(null);
  const [history, setHistory] = useState<{ key: string; items: TextVersion[] } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [newKey, setNewKey] = useState('');

  const load = useCallback(async () => {
    try {
      const [langs, list] = await Promise.all([api.texts.languages(), api.texts.list(namespace)]);
      setLanguages(langs);
      setItems(list);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить тексты'));
    }
  }, [namespace]);

  useEffect(() => {
    void load();
  }, [load]);

  const locales = languages.map((l) => l.code);
  const fields = TEXT_FIELDS[namespace];

  function startEdit(entry: TextEntry) {
    setEditing({ key: entry.key, draft: JSON.parse(JSON.stringify(entry)) });
    setHistory(null);
    setNotice(null);
  }

  function startNew() {
    const key = newKey.trim();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || items?.some((i) => i.key === key)) {
      setError('Ключ должен быть латиницей в snake_case и не повторяться');
      return;
    }
    setEditing({
      key,
      draft: {
        id: '00000000-0000-7000-8000-000000000000',
        namespace,
        key,
        sortOrder: (items?.length ?? 0) * 10,
        isActive: true,
        texts: {},
        updatedAt: new Date().toISOString(),
      },
    });
    setNewKey('');
    setError(null);
  }

  async function save(reason: string) {
    if (!editing) return;
    try {
      const saved = await api.texts.upsert(namespace, editing.key, {
        sortOrder: editing.draft.sortOrder,
        isActive: editing.draft.isActive,
        texts: editing.draft.texts,
        reason,
      });
      setNotice(`Запись «${saved.key}» сохранена: изменённые тексты опубликованы новыми версиями.`);
      setEditing(null);
      await load();
    } catch (err) {
      setError(problemText(err, 'Запись не сохранена'));
    }
  }

  async function showHistory(key: string) {
    try {
      setHistory({ key, items: await api.texts.history(namespace, key) });
    } catch (err) {
      setError(problemText(err, 'История недоступна'));
    }
  }

  const current = NAMESPACES.find((n) => n.key === namespace)!;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Словарь и ЧАВО</h1>
          <p className="page-hint">
            Тексты, которые основатель видит в подсказках и на странице словаря. Правка — новая
            версия с основанием; история сохраняется. Пустое поле на языке означает «нет перевода» —
            показывается запасной русский текст.
          </p>
        </div>
      </div>

      <div className="toolbar">
        {NAMESPACES.map((n) => (
          <button
            key={n.key}
            type="button"
            className={`btn--ghost${n.key === namespace ? ' navlink--active' : ''}`}
            onClick={() => {
              setNamespace(n.key);
              setEditing(null);
              setHistory(null);
            }}
          >
            {n.title}
          </button>
        ))}
        <span className="small muted">{current.hint}</span>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      <div className="toolbar">
        <input
          aria-label="Ключ новой записи"
          placeholder="ключ новой записи, например runway"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <button type="button" className="btn--ghost" onClick={startNew}>
          Новая запись
        </button>
      </div>

      {editing ? (
        <section className="card" data-text-editor={editing.key}>
          <h2>
            {items?.some((i) => i.key === editing.key) ? 'Запись' : 'Новая запись'}{' '}
            <code>{editing.key}</code>
          </h2>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="text-order">Порядок</label>
              <input
                id="text-order"
                type="number"
                min={0}
                value={editing.draft.sortOrder}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    draft: { ...editing.draft, sortOrder: Number(e.target.value) },
                  })
                }
              />
            </div>
            <div className="field">
              <label className="switch" style={{ marginTop: 26 }}>
                <input
                  type="checkbox"
                  checked={editing.draft.isActive}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      draft: { ...editing.draft, isActive: e.target.checked },
                    })
                  }
                />
                Показывать основателям
              </label>
            </div>
          </div>
          {locales.map((locale) => (
            <div className="card--flat" key={locale} style={{ marginBottom: 12 }}>
              <h3 style={{ marginTop: 0 }}>{locale}</h3>
              {fields.map((field) => {
                const meta = FIELD_LABEL[field] ?? { label: field, multiline: true };
                const value = editing.draft.texts[locale]?.[field] ?? '';
                const onChange = (next: string) =>
                  setEditing({
                    ...editing,
                    draft: {
                      ...editing.draft,
                      texts: {
                        ...editing.draft.texts,
                        [locale]: { ...(editing.draft.texts[locale] ?? {}), [field]: next },
                      },
                    },
                  });
                return (
                  <div className="field" key={field}>
                    <label htmlFor={`${locale}-${field}`}>{meta.label}</label>
                    {meta.multiline ? (
                      <textarea
                        id={`${locale}-${field}`}
                        rows={4}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                      />
                    ) : (
                      <input
                        id={`${locale}-${field}`}
                        value={value}
                        onChange={(e) => onChange(e.target.value)}
                      />
                    )}
                    {meta.multiline && value ? (
                      <div
                        className="field__hint"
                        style={{ border: '1px dashed var(--border)', padding: 8, marginTop: 6 }}
                      >
                        <Markdown source={value} />
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ))}
          <div className="row-actions">
            <button type="button" onClick={() => setConfirm(true)}>
              Сохранить новой версией
            </button>
            <button type="button" className="btn--ghost" onClick={() => setEditing(null)}>
              Отмена
            </button>
          </div>
        </section>
      ) : null}

      {history ? (
        <section className="card">
          <h2>
            История <code>{history.key}</code>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Язык</th>
                <th>Поле</th>
                <th>Версия</th>
                <th>Действует</th>
                <th>Текст</th>
                <th>Основание</th>
              </tr>
            </thead>
            <tbody>
              {history.items.map((v) => (
                <tr key={v.id}>
                  <td>{v.locale}</td>
                  <td>
                    <code>{v.field}</code>
                  </td>
                  <td>{v.version}</td>
                  <td className="small">
                    {formatDate(v.validFrom)} — {v.validTo ? formatDate(v.validTo) : 'сейчас'}
                  </td>
                  <td className="small">{v.body.slice(0, 120)}</td>
                  <td className="small">{v.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn--ghost btn--sm" onClick={() => setHistory(null)}>
            Закрыть
          </button>
        </section>
      ) : null}

      {items === null ? <div className="spinner">Загрузка…</div> : null}
      {items !== null ? (
        <section className="card">
          <table>
            <thead>
              <tr>
                <th>Ключ</th>
                <th>{namespace === 'glossary' ? 'Термин' : 'Вопрос'}</th>
                <th>Языки</th>
                <th>Состояние</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    Записей пока нет — создайте первую.
                  </td>
                </tr>
              ) : null}
              {items.map((entry) => {
                const head = entry.texts['ru-RU']?.[fields[0]!] ?? '—';
                const missing = locales.filter((l) => !entry.texts[l]?.[fields[0]!]);
                return (
                  <tr key={entry.id} data-text-entry={entry.key}>
                    <td>
                      <code>{entry.key}</code>
                    </td>
                    <td>{head}</td>
                    <td className="small">
                      {locales.map((l) => (
                        <span
                          key={l}
                          className={`badge ${missing.includes(l) ? 'badge--warn' : 'badge--ok'}`}
                          style={{ marginRight: 4 }}
                        >
                          {l}
                          {missing.includes(l) ? ' нет' : ''}
                        </span>
                      ))}
                    </td>
                    <td>
                      <span className={`badge ${entry.isActive ? 'badge--ok' : 'badge--muted'}`}>
                        {entry.isActive ? 'показывается' : 'скрыта'}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn--ghost btn--sm"
                          onClick={() => startEdit(entry)}
                        >
                          Править
                        </button>
                        <button
                          type="button"
                          className="btn--ghost btn--sm"
                          onClick={() => void showHistory(entry.key)}
                        >
                          История
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      <PromptDialog
        open={confirm}
        title="Сохранить новой версией"
        description="Изменённые тексты будут опубликованы новыми версиями; прежние останутся в истории."
        label="Основание"
        confirmText="Сохранить"
        onCancel={() => setConfirm(false)}
        onConfirm={(reason) => {
          setConfirm(false);
          void save(reason);
        }}
      />
    </>
  );
}
