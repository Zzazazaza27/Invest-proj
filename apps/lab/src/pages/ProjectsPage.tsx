import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  ErrorState,
  Field,
  HeroBanner,
  Icon,
  IconTile,
  Input,
  LoadingState,
  PageHeading,
  Stack,
  describeRaising,
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
      <PageHeading
        title="Мои проекты"
        description="Заявка, материалы и статус прохождения сезона"
        aside={
          <Button
            variant={creating ? 'secondary' : 'brand'}
            onClick={() => setCreating((value) => !value)}
          >
            {creating ? null : <Icon name="plus" size={16} />}
            {creating ? 'Отмена' : 'Новая заявка'}
          </Button>
        }
      />

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

      {/*
        Пустой список — не ошибка, а первый экран нового основателя, и
        выглядеть он должен приглашением, а не серым прямоугольником. Текст
        по-прежнему отвечает на два вопроса пустого состояния: почему пусто и
        что произойдёт после действия.
      */}
      {state.status === 'ready' && state.items.length === 0 && !creating ? (
        <HeroBanner
          icon="rocket"
          title="Проектов пока нет"
          description="Подайте заявку: после подачи проект получает неизменяемый снимок версии и уходит на анализ."
          action={
            <Button variant="secondary" onClick={() => setCreating(true)}>
              Новая заявка
            </Button>
          }
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
              {/*
                Кликабельна вся карточка, а не одно название: попасть в
                двухсловную ссылку на телефоне сложнее, чем в блок высотой
                в сотню пикселей. Это по-прежнему <button> — клавиатура и
                скринридер получают её без единого лишнего атрибута.
              */}
              <button
                type="button"
                className="u-tile-card"
                onClick={() => onOpen(project.id)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 'var(--u-space-4)',
                  width: '100%',
                  textAlign: 'left',
                  font: 'inherit',
                  color: 'var(--u-text)',
                  cursor: 'pointer',
                  padding: 'var(--u-space-5)',
                  background: 'var(--u-surface)',
                  border: '1px solid var(--u-border)',
                  borderRadius: 'var(--u-radius-lg)',
                  boxShadow: 'var(--u-shadow-sm)',
                }}
              >
                <IconTile name="rocket" size={44} />
                <span style={{ display: 'grid', gap: 'var(--u-space-2)', flex: 1, minWidth: 0 }}>
                  <ProjectBadges project={project} />
                  <span
                    style={{
                      fontSize: 'var(--u-text-lg)',
                      fontWeight: 800,
                      letterSpacing: '-0.01em',
                    }}
                  >
                    {project.title}
                  </span>
                  <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
                    {describeRaising(project)}
                    {project.requiredPlanCode ? ` · тариф ${project.requiredPlanCode}` : ''}
                  </span>
                </span>
                <Icon
                  name="chevronRight"
                  size={18}
                  style={{ color: 'var(--u-text-muted)', marginTop: 14 }}
                />
              </button>
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

          {/*
            Пока справочник направлений не загружен, `taxonomyId` пуст, и отправка
            формы ГАРАНТИРОВАННО получает 400: сервер требует направление. Это
            воспроизведено под нагрузкой — форма успевала отправиться раньше
            ответа справочника. Кнопка, ведущая только к отказу, не должна быть
            нажимаемой; причина названа словами, а не спрятана в disabled.
          */}
          <Button type="submit" variant="brand" loading={busy} disabled={taxonomy.length === 0}>
            Создать
          </Button>
          {taxonomy.length === 0 && !error ? (
            <div style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              Загружается справочник направлений — без него заявку принять нельзя.
            </div>
          ) : null}
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
