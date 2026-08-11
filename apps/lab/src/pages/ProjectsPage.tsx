import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import type { ProjectFull, ProjectSummary, TaxonomyNode } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { ProjectBadges } from '../App';

/**
 * Список проектов основателя и подача новой заявки.
 *
 * Форма отправляет ровно то, что принимает контракт: сумму запроса, стадию и
 * направление. Тариф по сумме резолвит СЕРВЕР — здесь его нет и быть не
 * должно, иначе клиент мог бы «выбрать себе» тариф дешевле.
 */
export function ProjectsPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ProjectSummary[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await api.projects.list() });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="var(--u-space-5)">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Мои проекты</h1>
        <Button onClick={() => setCreating((value) => !value)}>
          {creating ? 'Отмена' : 'Новая заявка'}
        </Button>
      </div>

      {creating ? (
        <CreateProjectForm
          onCreated={(project) => {
            setCreating(false);
            void load();
            onOpen(project.id);
          }}
        />
      ) : null}

      {state.status === 'loading' ? <LoadingState label="Загружаем проекты" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState
          title="Проектов пока нет"
          description="Подайте заявку: после подачи проект получает неизменяемый снимок версии и уходит на анализ."
          action={<Button onClick={() => setCreating(true)}>Новая заявка</Button>}
        />
      ) : null}

      {state.status === 'ready' && state.items.length > 0 ? (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'grid',
            gap: 'var(--u-space-4)',
          }}
        >
          {state.items.map((project) => (
            <li key={project.id}>
              <Card style={{ display: 'grid', gap: 'var(--u-space-3)' }}>
                <ProjectBadges project={project} />
                <button
                  type="button"
                  onClick={() => onOpen(project.id)}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    textAlign: 'left',
                    font: 'inherit',
                    color: 'var(--u-accent)',
                    fontSize: 'var(--u-text-lg)',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {project.title}
                </button>
                <span style={{ fontSize: 'var(--u-text-sm)' }}>
                  Запрос: {project.investmentAsk} {project.askCurrency}
                  {project.requiredPlanCode ? ` · тариф ${project.requiredPlanCode}` : ''}
                </span>
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </Stack>
  );
}

function CreateProjectForm({ onCreated }: { onCreated: (project: ProjectFull) => void }) {
  const [taxonomy, setTaxonomy] = useState<TaxonomyNode[]>([]);
  const [form, setForm] = useState({
    title: '',
    tagline: '',
    stage: 'mvp',
    taxonomyId: '',
    investmentAsk: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .taxonomy()
      .then((items) => {
        setTaxonomy(items);
        setForm((value) =>
          value.taxonomyId ? value : { ...value, taxonomyId: items[0]?.id ?? '' },
        );
      })
      .catch(() => setError('Справочник направлений недоступен — попробуйте позже'));
  }, []);

  return (
    <Card>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          setFieldErrors({});
          try {
            const project = await api.projects.create({
              title: form.title,
              tagline: form.tagline || undefined,
              stage: form.stage as 'idea' | 'mvp' | 'early_revenue' | 'growth',
              taxonomyId: form.taxonomyId,
              investmentAsk: form.investmentAsk,
              askCurrency: 'RUB',
            });
            onCreated(project);
          } catch (caught) {
            if (caught instanceof ApiError) {
              // Ошибки полей сервер отдаёт списком — показываем их у самих
              // полей, а не одной строкой «проверьте данные».
              const byField: Record<string, string> = {};
              for (const item of caught.problem?.errors ?? []) {
                byField[item.path] = item.message;
              }
              setFieldErrors(byField);
              setError(caught.problem?.detail ?? caught.message);
            } else {
              setError('Сервис недоступен');
            }
          } finally {
            setBusy(false);
          }
        }}
      >
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Новая заявка</h2>

          <Field label="Название" htmlFor="title" error={fieldErrors.title}>
            <Input
              id="title"
              required
              minLength={2}
              maxLength={200}
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
              aria-describedby={fieldErrors.title ? 'title-error' : undefined}
            />
          </Field>

          <Field label="Короткое описание" htmlFor="tagline" error={fieldErrors.tagline}>
            <Input
              id="tagline"
              maxLength={300}
              value={form.tagline}
              onChange={(event) => setForm({ ...form, tagline: event.target.value })}
            />
          </Field>

          <Field label="Стадия" htmlFor="stage" error={fieldErrors.stage}>
            <select
              id="stage"
              value={form.stage}
              onChange={(event) => setForm({ ...form, stage: event.target.value })}
              style={selectStyle}
            >
              <option value="idea">Идея</option>
              <option value="mvp">MVP</option>
              <option value="early_revenue">Первая выручка</option>
              <option value="growth">Рост</option>
            </select>
          </Field>

          <Field label="Направление" htmlFor="taxonomyId" error={fieldErrors.taxonomyId}>
            <select
              id="taxonomyId"
              value={form.taxonomyId}
              onChange={(event) => setForm({ ...form, taxonomyId: event.target.value })}
              style={selectStyle}
              required
            >
              {taxonomy.length === 0 ? <option value="">Загружается…</option> : null}
              {taxonomy.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.nameRu}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Запрос инвестиций, ₽"
            htmlFor="investmentAsk"
            error={fieldErrors.investmentAsk}
            hint="От суммы зависит тариф подписки — его определяет сервер"
          >
            <Input
              id="investmentAsk"
              inputMode="decimal"
              pattern="^\d+(\.\d{1,2})?$"
              placeholder="5000000.00"
              required
              value={form.investmentAsk}
              onChange={(event) => setForm({ ...form, investmentAsk: event.target.value })}
            />
          </Field>

          {error ? (
            <div role="alert" style={{ color: 'var(--u-danger)', fontSize: 'var(--u-text-sm)' }}>
              {error}
            </div>
          ) : null}

          <Button type="submit" loading={busy}>
            Создать
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

const selectStyle: React.CSSProperties = {
  minHeight: 44,
  padding: '0 var(--u-space-3)',
  borderRadius: 'var(--u-radius-md)',
  border: '1px solid var(--u-border-strong)',
  background: 'var(--u-surface)',
  color: 'var(--u-text)',
  fontSize: 'var(--u-text-md)',
  fontFamily: 'inherit',
  width: '100%',
};
