import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import type { ProjectTeaser } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Каталог проектов.
 *
 * Инвестор видит те же тизеры, что и аноним: полная карточка открывается
 * подпиской, и это решает СЕРВЕР. Кабинет не пытается угадать доступ и не
 * прячет кнопку «подробнее» — он отправляет запрос и показывает ответ, включая
 * отказ с объяснением, что нужна подписка.
 */
export function CatalogPage() {
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ProjectTeaser[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [details, setDetails] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const page = await api.catalog(applied ? { q: applied, limit: 24 } : { limit: 24 });
      setState({ status: 'ready', items: page.items });
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
  }, [applied]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Полная карточка: доступ проверяет сервер, а не эта функция. */
  const openDetails = useCallback(async (id: string) => {
    setDetails({ id, text: 'Загружаем…' });
    try {
      const passport = await api.projects.passport(id);
      setDetails({
        id,
        text: `Паспорт версии ${passport.version}, уровень раскрытия ${passport.disclosureTier}${
          passport.irs ? `, IRS ${passport.irs.value}` : ''
        }`,
      });
    } catch (error) {
      setDetails({
        id,
        text:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
      });
    }
  }, []);

  return (
    <Stack gap="var(--u-space-5)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Каталог проектов</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(query.trim());
        }}
        style={{ display: 'flex', gap: 'var(--u-space-3)' }}
      >
        <label htmlFor="catalog-search" className="u-visually-hidden">
          Поиск по каталогу
        </label>
        <Input
          id="catalog-search"
          type="search"
          placeholder="Поиск по названию или описанию"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button type="submit">Найти</Button>
      </form>

      {state.status === 'loading' ? <LoadingState label="Загружаем каталог" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState
          title={applied ? 'Ничего не найдено' : 'В каталоге пока пусто'}
          description={
            applied
              ? 'Поиск идёт по названию и описанию проекта — попробуйте другой запрос.'
              : 'Проекты появляются здесь после публикации листинга основателем.'
          }
          action={
            applied ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery('');
                  setApplied('');
                }}
              >
                Сбросить поиск
              </Button>
            ) : undefined
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
            gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          }}
        >
          {state.items.map((teaser) => (
            <li key={teaser.id}>
              <Card style={{ height: '100%', display: 'grid', gap: 'var(--u-space-3)' }}>
                <Badge tone="accent">{teaser.stage}</Badge>
                <strong style={{ fontSize: 'var(--u-text-lg)' }}>{teaser.title}</strong>
                {teaser.tagline ? (
                  <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {teaser.tagline}
                  </span>
                ) : null}
                <span style={{ fontWeight: 600 }}>
                  {teaser.investmentAsk} {teaser.askCurrency}
                </span>
                <Button variant="secondary" onClick={() => void openDetails(teaser.id)}>
                  Подробнее
                </Button>
                {details?.id === teaser.id ? (
                  <div
                    role="status"
                    style={{
                      padding: 'var(--u-space-3)',
                      borderRadius: 'var(--u-radius-md)',
                      background: 'var(--u-bg-inset)',
                      fontSize: 'var(--u-text-sm)',
                    }}
                  >
                    {details.text}
                  </div>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </Stack>
  );
}
