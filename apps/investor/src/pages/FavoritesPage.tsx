import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Stack } from '@unicorn/ui';
import type { FavoriteProject } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Избранные проекты инвестора.
 *
 * Отдельный раздел, а не фильтр каталога: отметка — это личный список, и
 * человек приходит сюда за ним, а не за поиском. Порядок задаёт момент
 * добавления, свежее сверху.
 *
 * Карточка здесь та же, что в каталоге: закладка не открывает данных, которых
 * инвестор без неё не видит. Полная карточка по-прежнему требует подписки, и
 * решает это сервер.
 */
export function FavoritesPage() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: FavoriteProject[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [details, setDetails] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', items: await api.favorites.list() });
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

  const remove = useCallback(
    async (projectId: string) => {
      setBusy(projectId);
      try {
        await api.favorites.remove(projectId);
        // Перечитывается СПИСОК, а не правится локальная копия: удаление уже
        // подтверждено сервером, и показывать надо его состояние.
        await load();
      } catch (error) {
        setDetails({
          id: projectId,
          text:
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Не удалось убрать из избранного',
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

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
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Избранные проекты</h1>

      {state.status === 'loading' ? <LoadingState label="Загружаем избранное" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      ) : null}

      {state.status === 'ready' && state.items.length === 0 ? (
        <EmptyState
          title="Избранного пока нет"
          description="Отметьте проект в каталоге кнопкой «В избранное» — он появится здесь и сохранится между сеансами."
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
          {state.items.map((item) => (
            <li key={item.id}>
              <Card style={{ height: '100%', display: 'grid', gap: 'var(--u-space-3)' }}>
                <Badge tone="accent">{item.stage}</Badge>
                <strong style={{ fontSize: 'var(--u-text-lg)' }}>{item.title}</strong>
                {item.tagline ? (
                  <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {item.tagline}
                  </span>
                ) : null}
                <span style={{ fontWeight: 600 }}>
                  {item.investmentAsk} {item.askCurrency}
                </span>
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-xs)' }}>
                  в избранном с {new Date(item.favoritedAt).toLocaleDateString('ru-RU')}
                </span>
                <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                  <Button variant="secondary" onClick={() => void openDetails(item.id)}>
                    Открыть
                  </Button>
                  <Button
                    variant="secondary"
                    loading={busy === item.id}
                    disabled={busy === item.id}
                    onClick={() => void remove(item.id)}
                  >
                    Убрать из избранного
                  </Button>
                </div>
                {details?.id === item.id ? (
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
