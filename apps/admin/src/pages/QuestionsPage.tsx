import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ApplicationFormConfig,
  ApplicationFormVersion,
  ApplicationFormVersions,
  ApplicationFormView,
  FormQuestion,
  FormQuestionType,
  FormSection,
  FormStageState,
  ProjectStage,
} from '@unicorn/contracts';
import { FORM_CORE_QUESTIONS, FORM_QUESTION_TYPES, validateFormConfig } from '@unicorn/contracts';
import { Markdown, PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Вопросы инвестиционной заявки (этап 5.1–5.2, план 0.2 §0в).
 *
 * Администратор работает с таблицей стадий и карточкой вопроса; документ
 * конфигурации собирается здесь и уходит на сервер целиком, где проходит
 * схему и правила эволюции. Правки живут в ЧЕРНОВИКЕ и не видны основателям
 * до «Опубликовать»; откат — «Вернуть версию N». Заявки, созданные на
 * прежней версии, остаются на ней — это свойство ядра, а не экрана.
 */

const STAGES: { key: ProjectStage; label: string }[] = [
  { key: 'idea', label: 'Идея' },
  { key: 'mvp', label: 'MVP' },
  { key: 'early_revenue', label: 'Первые продажи' },
  { key: 'growth', label: 'Рост' },
];

const STATE_LABEL: Record<FormStageState, string> = {
  mandatory: 'Обязательный',
  recommended: 'Рекомендуемый',
  hidden: 'Не показывать',
};

const TYPE_LABEL: Record<FormQuestionType, string> = {
  text: 'строка',
  textarea: 'текст',
  number: 'число',
  money: 'сумма',
  select: 'выбор одного',
  multiselect: 'выбор нескольких',
  boolean: 'да / нет',
  url: 'ссылка',
  date: 'дата',
  material_ref: 'материал',
};

const VISIBILITY_LABEL = {
  public: 'публично (карточка)',
  investors: 'инвесторам',
  platform: 'только платформе',
  private: 'только владельцу и админу',
} as const;

const QUESTION_TEXT_FIELDS: { field: string; label: string; multiline: boolean }[] = [
  { field: 'label', label: 'Формулировка', multiline: false },
  { field: 'placeholder', label: 'Подсказка в поле (placeholder)', multiline: false },
  { field: 'help_md', label: 'Подсказка (Markdown)', multiline: true },
  { field: 'example_good_md', label: 'Пример хорошего ответа (Markdown)', multiline: true },
  { field: 'example_weak_md', label: 'Пример слабого ответа (Markdown)', multiline: true },
];

export function QuestionsPage() {
  const [versions, setVersions] = useState<ApplicationFormVersions | null>(null);
  const [draft, setDraft] = useState<ApplicationFormVersion | null>(null);
  const [config, setConfig] = useState<ApplicationFormConfig | null>(null);
  const [active, setActive] = useState<ApplicationFormConfig | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [openSection, setOpenSection] = useState<string | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'publish' }
    | { kind: 'activate'; version: number }
    | { kind: 'new-question' }
    | { kind: 'new-section' }
    | { kind: 'new-locale' }
    | null
  >(null);
  const [preview, setPreview] = useState<{
    stage: ProjectStage;
    locale: string;
    view: ApplicationFormView | null;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, current] = await Promise.all([
        api.applicationForms.list(),
        api.applicationForms.draft(),
      ]);
      setVersions(list);
      setDraft(current);
      setConfig(current.config);
      setDirty(false);
      if (list.activeVersion !== null) {
        setActive((await api.applicationForms.version(list.activeVersion)).config);
      }
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить конфигурацию вопросов'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Локальные ошибки документа — те же правила, что на сервере, но без запроса. */
  const issues = useMemo(() => (config ? validateFormConfig(config) : []), [config]);

  const update = (mutate: (next: ApplicationFormConfig) => void) => {
    setConfig((current) => {
      if (!current) return current;
      const next: ApplicationFormConfig = JSON.parse(JSON.stringify(current));
      mutate(next);
      return next;
    });
    setDirty(true);
    setNotice(null);
  };

  async function run(key: string, action: () => Promise<string>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (err) {
      setError(problemText(err, 'Операция не выполнена'));
    } finally {
      setBusy(null);
    }
  }

  const saveDraft = () =>
    run('save', async () => {
      if (!config) return '';
      const saved = await api.applicationForms.saveDraft(config);
      setDraft(saved);
      setConfig(saved.config);
      setDirty(false);
      return 'Черновик сохранён. Основатели его не видят до публикации.';
    });

  /**
   * Сбросить черновик — заменить его копией активной версии. Нужен, когда
   * правки зашли не туда или после отката: черновик остаётся от прежней
   * версии, и это видно в строке состояния. Опубликованное не затрагивается.
   */
  const resetDraft = () =>
    run('reset', async () => {
      if (!active) return '';
      if (
        !window.confirm(
          'Сбросить черновик к активной версии? Несохранённые и сохранённые правки черновика будут заменены.',
        )
      ) {
        return '';
      }
      const saved = await api.applicationForms.saveDraft(active);
      setDraft(saved);
      setConfig(saved.config);
      setDirty(false);
      return `Черновик сброшен к активной версии ${versions?.activeVersion ?? ''}.`;
    });

  const publish = (reason: string) =>
    run('publish', async () => {
      if (config && dirty) {
        const saved = await api.applicationForms.saveDraft(config);
        setConfig(saved.config);
        setDirty(false);
      }
      const published = await api.applicationForms.publish(reason);
      await load();
      return `Опубликована версия ${published.version}. Новые заявки создаются на ней; начатые черновики остаются на своих версиях.`;
    });

  const activate = (version: number, reason: string) =>
    run('activate', async () => {
      await api.applicationForms.activate(version, reason);
      await load();
      return `Версия ${version} снова активна для новых заявок.`;
    });

  const showPreview = async (stage: ProjectStage, locale: string) => {
    setPreview({ stage, locale, view: null });
    try {
      if (config && dirty) {
        const saved = await api.applicationForms.saveDraft(config);
        setConfig(saved.config);
        setDirty(false);
      }
      const view = await api.applicationForms.preview(stage, locale);
      setPreview({ stage, locale, view });
    } catch (err) {
      setError(problemText(err, 'Предпросмотр не собран'));
      setPreview(null);
    }
  };

  if (error && !config) return <div className="alert alert--error">{error}</div>;
  if (!config || !versions) return <div className="spinner">Загрузка…</div>;

  const sections = [...config.sections].sort((a, b) => a.order - b.order);
  const questionsOf = (sectionKey: string) =>
    config.questions
      .filter((q) => q.section === sectionKey)
      .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  const locales = config.locales;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Вопросы заявки</h1>
          <p className="page-hint">
            Таблица по разделам мастера: в каждой ячейке стадии — одно из трёх состояний. Изменения
            копятся в черновике и попадают к основателям только после «Опубликовать». Заявки,
            начатые на прежней версии, остаются на ней. Откат — «Вернуть версию» в истории.
            Системные поля (стадия, сумма, предмет финансирования) — ключ и тип заблокированы.
          </p>
        </div>
        <div className="row-actions">
          <button
            type="button"
            className="btn--ghost"
            onClick={() => setDialog({ kind: 'new-section' })}
          >
            Добавить раздел
          </button>
          <button
            type="button"
            className="btn--ghost"
            onClick={() => setDialog({ kind: 'new-question' })}
          >
            Добавить вопрос
          </button>
          <button
            type="button"
            className="btn--ghost"
            onClick={() => setDialog({ kind: 'new-locale' })}
          >
            Добавить язык
          </button>
          <button
            type="button"
            className="btn--ghost"
            disabled={busy !== null || !dirty}
            onClick={() => void saveDraft()}
          >
            Сохранить черновик
          </button>
          <button
            type="button"
            className="btn--ghost"
            disabled={busy !== null || !active}
            onClick={() => void resetDraft()}
          >
            Сбросить черновик
          </button>
          <button
            type="button"
            disabled={busy !== null || issues.length > 0}
            onClick={() => setDialog({ kind: 'publish' })}
          >
            Опубликовать
          </button>
        </div>
      </div>

      <div className="toolbar" data-form-status>
        <span className={`badge ${dirty ? 'badge--warn' : 'badge--muted'}`}>
          {dirty ? 'есть несохранённые правки' : 'черновик совпадает с сохранённым'}
        </span>
        <span className="small muted">
          Активная версия: <strong>{versions.activeVersion ?? '—'}</strong>
          {draft?.basedOnVersion ? ` · черновик от версии ${draft.basedOnVersion}` : ''} · языки:{' '}
          {locales.join(', ')}
        </span>
        <span className="small muted">Предпросмотр формы:</span>
        {STAGES.map((s) => (
          <button
            key={s.key}
            type="button"
            className="btn--ghost btn--sm"
            onClick={() => void showPreview(s.key, config.defaultLocale)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}
      {issues.length > 0 && (
        <div className="alert alert--error">
          Документ нельзя опубликовать, пока есть ошибки:
          <ul style={{ margin: '6px 0 0 18px' }}>
            {issues.slice(0, 8).map((i) => (
              <li key={i.path}>
                <code>{i.path}</code> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && (
        <PreviewCard
          preview={preview}
          locales={locales}
          onChange={(stage, locale) => void showPreview(stage, locale)}
          onClose={() => setPreview(null)}
        />
      )}

      {sections.map((section, index) => (
        <section className="card" key={section.key} data-section={section.key}>
          <div className="page-head" style={{ marginBottom: 10 }}>
            <div>
              <h2 style={{ marginBottom: 2 }}>
                {index + 1}. {section.texts[config.defaultLocale]?.title ?? section.key}
              </h2>
              <div className="small muted">раздел {section.key}</div>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn--ghost btn--sm"
                disabled={index === 0}
                onClick={() => update((c) => moveSection(c, section.key, -1))}
                aria-label="Раздел выше"
              >
                ↑
              </button>
              <button
                type="button"
                className="btn--ghost btn--sm"
                disabled={index === sections.length - 1}
                onClick={() => update((c) => moveSection(c, section.key, 1))}
                aria-label="Раздел ниже"
              >
                ↓
              </button>
              <button
                type="button"
                className="btn--ghost btn--sm"
                onClick={() => setOpenSection(openSection === section.key ? null : section.key)}
              >
                {openSection === section.key ? 'Скрыть тексты раздела' : 'Тексты раздела'}
              </button>
            </div>
          </div>

          {openSection === section.key && (
            <SectionEditor
              section={section}
              locales={locales}
              defaultLocale={config.defaultLocale}
              onChange={(locale, field, value) =>
                update((c) => {
                  const s = c.sections.find((x) => x.key === section.key)!;
                  s.texts[locale] = { ...(s.texts[locale] ?? {}) };
                  if (value === '') delete s.texts[locale]![field];
                  else s.texts[locale]![field] = value;
                })
              }
            />
          )}

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Вопрос</th>
                  {STAGES.map((s) => (
                    <th key={s.key}>{s.label}</th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {questionsOf(section.key).map((question, qIndex, list) => {
                  const core = question.coreField ? FORM_CORE_QUESTIONS[question.coreField] : null;
                  const fixed = core?.fixedState;
                  const archived = Boolean(question.archivedAt);
                  return (
                    <QuestionRows
                      key={question.key}
                      question={question}
                      defaultLocale={config.defaultLocale}
                      locales={locales}
                      sections={sections}
                      fixedState={fixed ?? null}
                      archived={archived}
                      isFirst={qIndex === 0}
                      isLast={qIndex === list.length - 1}
                      open={openCard === question.key}
                      activeLabel={
                        active?.questions.find((q) => q.key === question.key)?.texts[
                          config.defaultLocale
                        ]?.label ?? null
                      }
                      onToggleCard={() =>
                        setOpenCard(openCard === question.key ? null : question.key)
                      }
                      onState={(stage, state) =>
                        update((c) => {
                          c.questions.find((q) => q.key === question.key)!.stages[stage] = state;
                        })
                      }
                      onMove={(delta) => update((c) => moveQuestion(c, question.key, delta))}
                      onArchive={(value) =>
                        update((c) => {
                          c.questions.find((q) => q.key === question.key)!.archivedAt = value
                            ? new Date().toISOString()
                            : null;
                        })
                      }
                      onEdit={(mutate) =>
                        update((c) => mutate(c.questions.find((q) => q.key === question.key)!))
                      }
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <section className="card">
        <h2>История версий</h2>
        <p className="page-hint">
          Ни одна версия не удаляется. «Вернуть версию» делает её активной для новых заявок;
          поданные и начатые заявки не пересчитываются.
        </p>
        <table>
          <thead>
            <tr>
              <th>Версия</th>
              <th>Состояние</th>
              <th>Опубликована</th>
              <th>Основание</th>
              <th>Разделов / вопросов</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.items.map((v) => (
              <tr key={v.id} data-version={v.version ?? ''}>
                <td>{v.version}</td>
                <td>
                  <span className={`badge ${v.isActive ? 'badge--ok' : 'badge--muted'}`}>
                    {v.isActive ? 'активна' : 'в истории'}
                  </span>
                </td>
                <td className="small">{v.publishedAt ? formatDate(v.publishedAt) : '—'}</td>
                <td className="small">{v.reason ?? '—'}</td>
                <td className="small">
                  {v.sections} / {v.questions}
                </td>
                <td>
                  {!v.isActive && v.version !== null ? (
                    <button
                      type="button"
                      className="btn--ghost btn--sm"
                      disabled={busy !== null}
                      onClick={() => setDialog({ kind: 'activate', version: v.version! })}
                    >
                      Вернуть версию {v.version}
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <PromptDialog
        open={dialog?.kind === 'publish'}
        title="Опубликовать новую версию"
        description="Черновик станет активной версией для новых заявок. Начатые черновики основателей останутся на своих версиях. Основание попадёт в журнал."
        label="Основание"
        confirmText="Опубликовать"
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => {
          setDialog(null);
          void publish(reason);
        }}
      />
      <PromptDialog
        open={dialog?.kind === 'activate'}
        title={dialog?.kind === 'activate' ? `Вернуть версию ${dialog.version}` : ''}
        description="Прежняя версия снова станет активной для новых заявок. Это откат, а не удаление: текущая активная останется в истории."
        label="Основание"
        confirmText="Вернуть"
        onCancel={() => setDialog(null)}
        onConfirm={(reason) => {
          const d = dialog;
          setDialog(null);
          if (d?.kind === 'activate') void activate(d.version, reason);
        }}
      />
      {dialog?.kind === 'new-question' && (
        <NewQuestionDialog
          sections={sections}
          defaultLocale={config.defaultLocale}
          existingKeys={config.questions.map((q) => q.key)}
          onCancel={() => setDialog(null)}
          onCreate={(question) => {
            setDialog(null);
            update((c) => {
              c.questions.push(question);
            });
            setOpenCard(question.key);
          }}
        />
      )}
      {dialog?.kind === 'new-section' && (
        <NewKeyDialog
          title="Новый раздел"
          label="Ключ раздела (латиница, snake_case)"
          existingKeys={config.sections.map((s) => s.key)}
          onCancel={() => setDialog(null)}
          onCreate={(key) => {
            setDialog(null);
            update((c) => {
              const order = Math.max(0, ...c.sections.map((s) => s.order)) + 10;
              c.sections.push({
                key,
                order,
                texts: { [c.defaultLocale]: { title: key } },
              });
            });
            setOpenSection(key);
          }}
        />
      )}
      {dialog?.kind === 'new-locale' && (
        <NewKeyDialog
          title="Новый язык"
          label="Код языка, например en-US"
          pattern={/^[a-z]{2}-[A-Z]{2}$/}
          existingKeys={locales}
          onCancel={() => setDialog(null)}
          onCreate={(code) => {
            setDialog(null);
            update((c) => {
              c.locales.push(code);
            });
          }}
        />
      )}
    </>
  );
}

// ------------------------------------------------------------ строки таблицы

function QuestionRows({
  question,
  defaultLocale,
  locales,
  sections,
  fixedState,
  archived,
  isFirst,
  isLast,
  open,
  activeLabel,
  onToggleCard,
  onState,
  onMove,
  onArchive,
  onEdit,
}: {
  question: FormQuestion;
  defaultLocale: string;
  locales: string[];
  sections: FormSection[];
  fixedState: FormStageState | null;
  archived: boolean;
  isFirst: boolean;
  isLast: boolean;
  open: boolean;
  activeLabel: string | null;
  onToggleCard: () => void;
  onState: (stage: ProjectStage, state: FormStageState) => void;
  onMove: (delta: -1 | 1) => void;
  onArchive: (archived: boolean) => void;
  onEdit: (mutate: (q: FormQuestion) => void) => void;
}) {
  const label = question.texts[defaultLocale]?.label ?? question.key;
  const missing = locales.filter((l) => !question.texts[l]?.label);
  return (
    <>
      <tr data-question={question.key} style={archived ? { opacity: 0.55 } : undefined}>
        <td>
          <div>{label}</div>
          <div className="small muted">
            {question.key} · {TYPE_LABEL[question.type]}
            {question.coreField ? ' · системное' : ''}
            {archived ? ' · в архиве' : ''}
            {missing.length > 0 && !archived ? ` · нет перевода: ${missing.join(', ')}` : ''}
          </div>
        </td>
        {STAGES.map((s) => (
          <td key={s.key}>
            <select
              aria-label={`${label}: ${s.label}`}
              value={question.stages[s.key]}
              disabled={Boolean(fixedState) || archived}
              onChange={(e) => onState(s.key, e.target.value as FormStageState)}
              style={{ minWidth: 150 }}
            >
              {(Object.keys(STATE_LABEL) as FormStageState[]).map((state) => (
                <option key={state} value={state}>
                  {STATE_LABEL[state]}
                </option>
              ))}
            </select>
          </td>
        ))}
        <td>
          <div className="row-actions">
            <button
              type="button"
              className="btn--ghost btn--sm"
              disabled={isFirst}
              onClick={() => onMove(-1)}
              aria-label="Выше"
            >
              ↑
            </button>
            <button
              type="button"
              className="btn--ghost btn--sm"
              disabled={isLast}
              onClick={() => onMove(1)}
              aria-label="Ниже"
            >
              ↓
            </button>
            <button type="button" className="btn--ghost btn--sm" onClick={onToggleCard}>
              {open ? 'Свернуть' : 'Карточка'}
            </button>
            {!question.coreField ? (
              <button
                type="button"
                className={`btn--sm ${archived ? 'btn--ghost' : 'btn--danger'}`}
                onClick={() => onArchive(!archived)}
              >
                {archived ? 'Восстановить' : 'Архивировать'}
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={STAGES.length + 2} style={{ background: 'var(--surface-2, transparent)' }}>
            <QuestionCard
              question={question}
              locales={locales}
              defaultLocale={defaultLocale}
              sections={sections}
              activeLabel={activeLabel}
              onEdit={onEdit}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------ карточка

/** Похожесть формулировок: доля общих слов. Ниже порога — смысл сменился. */
function similarity(a: string, b: string): number {
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2),
    );
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 || wb.size === 0) return 1;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / Math.max(wa.size, wb.size);
}

function QuestionCard({
  question,
  locales,
  defaultLocale,
  sections,
  activeLabel,
  onEdit,
}: {
  question: FormQuestion;
  locales: string[];
  defaultLocale: string;
  sections: FormSection[];
  activeLabel: string | null;
  onEdit: (mutate: (q: FormQuestion) => void) => void;
}) {
  const [locale, setLocale] = useState(defaultLocale);
  const texts = question.texts[locale] ?? {};
  const currentLabel = question.texts[defaultLocale]?.label ?? '';
  const meaningChanged =
    activeLabel !== null &&
    currentLabel !== activeLabel &&
    similarity(activeLabel, currentLabel) < 0.5;
  const isChoice = question.type === 'select' || question.type === 'multiselect';
  const core = question.coreField ? FORM_CORE_QUESTIONS[question.coreField] : null;

  return (
    <div style={{ display: 'grid', gap: 12, padding: '6px 0' }} data-card={question.key}>
      {meaningChanged ? (
        <div className="alert alert--info">
          Формулировка изменилась существенно по сравнению с опубликованной («{activeLabel}»). Если
          сменился смысл вопроса, создайте новый вопрос и архивируйте этот: старые ответы не должны
          получить новый смысл задним числом.
        </div>
      ) : null}
      <div className="toolbar">
        <span className="small muted">Язык текстов:</span>
        {locales.map((l) => (
          <button
            key={l}
            type="button"
            className={`btn--ghost btn--sm${l === locale ? ' navlink--active' : ''}`}
            onClick={() => setLocale(l)}
          >
            {l}
            {question.texts[l]?.label ? '' : ' (нет перевода)'}
          </button>
        ))}
      </div>
      <div className="grid-2">
        {QUESTION_TEXT_FIELDS.map(({ field, label, multiline }) => (
          <div
            className="field"
            key={field}
            style={multiline ? { gridColumn: '1 / -1' } : undefined}
          >
            <label htmlFor={`${question.key}-${locale}-${field}`}>{label}</label>
            {multiline ? (
              <textarea
                id={`${question.key}-${locale}-${field}`}
                rows={4}
                value={texts[field] ?? ''}
                onChange={(e) => onEdit((q) => setText(q, locale, field, e.target.value))}
              />
            ) : (
              <input
                id={`${question.key}-${locale}-${field}`}
                value={texts[field] ?? ''}
                onChange={(e) => onEdit((q) => setText(q, locale, field, e.target.value))}
              />
            )}
            {multiline && texts[field] ? (
              <div
                className="field__hint"
                style={{ border: '1px dashed var(--border)', padding: 8, marginTop: 6 }}
              >
                <span className="small muted">Предпросмотр:</span>
                <Markdown source={texts[field]} />
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="grid-3">
        <div className="field">
          <label htmlFor={`${question.key}-section`}>Раздел</label>
          <select
            id={`${question.key}-section`}
            value={question.section}
            onChange={(e) => onEdit((q) => (q.section = e.target.value))}
          >
            {sections.map((s) => (
              <option key={s.key} value={s.key}>
                {s.texts[defaultLocale]?.title ?? s.key}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${question.key}-visibility`}>Видимость</label>
          <select
            id={`${question.key}-visibility`}
            value={question.visibility}
            onChange={(e) =>
              onEdit((q) => (q.visibility = e.target.value as FormQuestion['visibility']))
            }
          >
            {(Object.keys(VISIBILITY_LABEL) as (keyof typeof VISIBILITY_LABEL)[]).map((v) => (
              <option key={v} value={v}>
                {VISIBILITY_LABEL[v]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="switch" style={{ marginTop: 26 }}>
            <input
              type="checkbox"
              checked={question.evidence ?? false}
              onChange={(e) => onEdit((q) => (q.evidence = e.target.checked))}
            />
            Можно приложить подтверждение
          </label>
        </div>
      </div>

      {isChoice ? (
        <div className="field">
          <label>
            Варианты ({core?.options ? 'коды системного поля фиксированы' : 'код и подпись'})
          </label>
          <table>
            <thead>
              <tr>
                <th>Код</th>
                <th>Подпись ({locale})</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(question.options ?? []).map((option, index) => (
                <tr key={option.code}>
                  <td>
                    <code>{option.code}</code>
                  </td>
                  <td>
                    <input
                      aria-label={`Подпись варианта ${option.code}`}
                      value={option.texts[locale]?.label ?? ''}
                      onChange={(e) =>
                        onEdit((q) => {
                          const o = q.options![index]!;
                          o.texts[locale] = { ...(o.texts[locale] ?? {}), label: e.target.value };
                        })
                      }
                    />
                  </td>
                  <td>
                    {!core?.options ? (
                      <button
                        type="button"
                        className="btn--ghost btn--sm"
                        onClick={() => onEdit((q) => q.options!.splice(index, 1))}
                      >
                        Убрать
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!core?.options ? (
            <AddOption
              onAdd={(code, label) =>
                onEdit((q) => {
                  q.options = [...(q.options ?? []), { code, texts: { [locale]: { label } } }];
                })
              }
            />
          ) : null}
        </div>
      ) : null}
      <div className="small muted">
        Тип поля: {TYPE_LABEL[question.type]} — меняется только новым вопросом. Ограничения и связь
        с оценкой — зона разработчика.
      </div>
    </div>
  );
}

function setText(q: FormQuestion, locale: string, field: string, value: string) {
  q.texts[locale] = { ...(q.texts[locale] ?? {}) };
  if (value === '') delete q.texts[locale]![field];
  else q.texts[locale]![field] = value;
}

function AddOption({ onAdd }: { onAdd: (code: string, label: string) => void }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const valid = /^[a-z][a-z0-9_]{0,63}$/.test(code) && label.trim() !== '';
  return (
    <div className="toolbar" style={{ marginTop: 8 }}>
      <input
        aria-label="Код нового варианта"
        placeholder="код, например other"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        style={{ maxWidth: 200 }}
      />
      <input
        aria-label="Подпись нового варианта"
        placeholder="подпись"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        style={{ maxWidth: 320 }}
      />
      <button
        type="button"
        className="btn--ghost btn--sm"
        disabled={!valid}
        onClick={() => {
          onAdd(code, label.trim());
          setCode('');
          setLabel('');
        }}
      >
        Добавить вариант
      </button>
    </div>
  );
}

function SectionEditor({
  section,
  locales,
  defaultLocale,
  onChange,
}: {
  section: FormSection;
  locales: string[];
  defaultLocale: string;
  onChange: (locale: string, field: string, value: string) => void;
}) {
  const [locale, setLocale] = useState(defaultLocale);
  const texts = section.texts[locale] ?? {};
  return (
    <div className="card--flat" style={{ marginBottom: 12 }}>
      <div className="toolbar">
        <span className="small muted">Язык:</span>
        {locales.map((l) => (
          <button
            key={l}
            type="button"
            className={`btn--ghost btn--sm${l === locale ? ' navlink--active' : ''}`}
            onClick={() => setLocale(l)}
          >
            {l}
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor={`${section.key}-${locale}-title`}>Заголовок раздела</label>
        <input
          id={`${section.key}-${locale}-title`}
          value={texts.title ?? ''}
          onChange={(e) => onChange(locale, 'title', e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={`${section.key}-${locale}-intro`}>Вводный текст (Markdown)</label>
        <textarea
          id={`${section.key}-${locale}-intro`}
          rows={3}
          value={texts.intro_md ?? ''}
          onChange={(e) => onChange(locale, 'intro_md', e.target.value)}
        />
        {texts.intro_md ? (
          <div className="field__hint">
            <Markdown source={texts.intro_md} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ предпросмотр

function PreviewCard({
  preview,
  locales,
  onChange,
  onClose,
}: {
  preview: { stage: ProjectStage; locale: string; view: ApplicationFormView | null };
  locales: string[];
  onChange: (stage: ProjectStage, locale: string) => void;
  onClose: () => void;
}) {
  return (
    <section className="card" data-preview-form>
      <div className="page-head" style={{ marginBottom: 8 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Предпросмотр формы из черновика</h2>
          <div className="small muted">
            Так увидит основатель на стадии «{STAGES.find((s) => s.key === preview.stage)?.label}»
            после публикации. Скрытые вопросы не показаны.
          </div>
        </div>
        <div className="row-actions">
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`btn--ghost btn--sm${s.key === preview.stage ? ' navlink--active' : ''}`}
              onClick={() => onChange(s.key, preview.locale)}
            >
              {s.label}
            </button>
          ))}
          {locales.length > 1
            ? locales.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`btn--ghost btn--sm${l === preview.locale ? ' navlink--active' : ''}`}
                  onClick={() => onChange(preview.stage, l)}
                >
                  {l}
                </button>
              ))
            : null}
          <button type="button" className="btn--ghost btn--sm" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
      {!preview.view ? <div className="spinner">Собираем…</div> : null}
      {preview.view ? (
        <div style={{ display: 'grid', gap: 12 }}>
          {preview.view.missing.length > 0 ? (
            <div className="alert alert--info">
              Нет перевода на {preview.locale}: {preview.view.missing.length} текстов — показан
              запасной язык.
            </div>
          ) : null}
          {preview.view.sections.map((section, i) => (
            <div key={section.key}>
              <strong>
                {i + 1}. {section.title}
              </strong>
              {section.introMd ? (
                <div className="small muted">
                  <Markdown source={section.introMd} />
                </div>
              ) : null}
              <ol style={{ margin: '4px 0 0 18px' }}>
                {section.questions.map((q) => (
                  <li key={q.key}>
                    {q.label}{' '}
                    <span
                      className={`badge ${q.state === 'mandatory' ? 'badge--ok' : 'badge--muted'}`}
                    >
                      {q.state === 'mandatory' ? 'обязательный' : 'рекомендуемый'}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------ диалоги

function NewQuestionDialog({
  sections,
  defaultLocale,
  existingKeys,
  onCancel,
  onCreate,
}: {
  sections: FormSection[];
  defaultLocale: string;
  existingKeys: string[];
  onCancel: () => void;
  onCreate: (question: FormQuestion) => void;
}) {
  const [key, setKey] = useState('');
  const [type, setType] = useState<FormQuestionType>('textarea');
  const [section, setSection] = useState(sections[0]?.key ?? '');
  const [label, setLabel] = useState('');
  const keyValid = /^[a-z][a-z0-9_]{0,63}$/.test(key) && !existingKeys.includes(key);
  const isChoice = type === 'select' || type === 'multiselect';
  return (
    <div className="card" role="dialog" aria-label="Новый вопрос" data-dialog="new-question">
      <h2>Новый вопрос</h2>
      <p className="page-hint">
        Ключ — стабильный, латиницей, задаётся один раз; тип из поддерживаемых. Новый вопрос
        появится у основателей после публикации. Он не влияет на инвестиционную оценку.
      </p>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="nq-key">Ключ</label>
          <input
            id="nq-key"
            value={key}
            onChange={(e) => setKey(e.target.value.trim())}
            placeholder="например, pilot_customers"
          />
          {key && !keyValid ? (
            <div className="field__hint">ключ занят или не в формате snake_case</div>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor="nq-type">Тип поля</label>
          <select
            id="nq-type"
            value={type}
            onChange={(e) => setType(e.target.value as FormQuestionType)}
          >
            {FORM_QUESTION_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nq-section">Раздел</label>
          <select id="nq-section" value={section} onChange={(e) => setSection(e.target.value)}>
            {sections.map((s) => (
              <option key={s.key} value={s.key}>
                {s.texts[defaultLocale]?.title ?? s.key}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="nq-label">Формулировка ({defaultLocale})</label>
        <input id="nq-label" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="row-actions">
        <button
          type="button"
          disabled={!keyValid || label.trim() === '' || section === ''}
          onClick={() =>
            onCreate({
              key,
              section,
              order: 9999,
              type,
              ...(isChoice
                ? {
                    options: [
                      { code: 'option_1', texts: { [defaultLocale]: { label: 'Вариант 1' } } },
                    ],
                  }
                : {}),
              stages: { idea: 'hidden', mvp: 'hidden', early_revenue: 'hidden', growth: 'hidden' },
              visibility: 'investors',
              texts: { [defaultLocale]: { label: label.trim() } },
            })
          }
        >
          Создать черновик вопроса
        </button>
        <button type="button" className="btn--ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

function NewKeyDialog({
  title,
  label,
  pattern = /^[a-z][a-z0-9_]{0,63}$/,
  existingKeys,
  onCancel,
  onCreate,
}: {
  title: string;
  label: string;
  pattern?: RegExp;
  existingKeys: string[];
  onCancel: () => void;
  onCreate: (key: string) => void;
}) {
  const [value, setValue] = useState('');
  const valid = pattern.test(value) && !existingKeys.includes(value);
  return (
    <div className="card" role="dialog" aria-label={title}>
      <h2>{title}</h2>
      <div className="field">
        <label htmlFor="nk-value">{label}</label>
        <input id="nk-value" value={value} onChange={(e) => setValue(e.target.value.trim())} />
      </div>
      <div className="row-actions">
        <button type="button" disabled={!valid} onClick={() => onCreate(value)}>
          Добавить
        </button>
        <button type="button" className="btn--ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ порядок

function moveSection(config: ApplicationFormConfig, key: string, delta: -1 | 1) {
  const sorted = [...config.sections].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((s) => s.key === key);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= sorted.length) return;
  const a = sorted[index]!;
  const b = sorted[target]!;
  [a.order, b.order] = [b.order, a.order];
  if (a.order === b.order) b.order += delta;
}

function moveQuestion(config: ApplicationFormConfig, key: string, delta: -1 | 1) {
  const question = config.questions.find((q) => q.key === key);
  if (!question) return;
  const list = config.questions
    .filter((q) => q.section === question.section)
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  // Перенумеровать раздел целиком: так «поменять местами» не зависит от дубликатов.
  list.forEach((q, i) => (q.order = (i + 1) * 10));
  const index = list.findIndex((q) => q.key === key);
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const other = list[target]!;
  [question.order, other.order] = [other.order, question.order];
}
