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
  formatMoney,
} from '@unicorn/ui';
import type { InvestmentPassport, ProjectFull, ProjectTeaser } from '@unicorn/contracts';
import { ApiError, api } from '../api';

/** Строка «подпись — значение» внутри раскрытой карточки проекта. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--u-space-2)' }}>
      <dt style={{ color: 'var(--u-text-muted)', minWidth: '10rem' }}>{label}</dt>
      <dd style={{ margin: 0 }}>{children}</dd>
    </div>
  );
}

/**
 * Стадия проекта по-человечески.
 *
 * В карточке каталога стояло сырое `growth`: инвестор видит английский код там,
 * где ждёт стадию проекта на своём языке.
 */
const STAGE_TITLES: Record<string, string> = {
  idea: 'идея',
  mvp: 'MVP',
  early_revenue: 'первая выручка',
  growth: 'рост',
};

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
  const [details, setDetails] = useState<
    | { id: string; state: 'loading' }
    | { id: string; state: 'ready'; project: ProjectFull; passport: InvestmentPassport | null }
    | { id: string; state: 'error'; message: string }
    | null
  >(null);
  /**
   * Отметки избранного.
   *
   * Хранятся на сервере; здесь — только копия для отрисовки. Список
   * идентификаторов берётся ОДНИМ запросом на всю страницу: спрашивать
   * «в избранном ли этот проект» по карточке означало бы двадцать четыре
   * запроса на открытие каталога.
   */
  const [favorites, setFavorites] = useState<Set<string>>(new Set());
  const [favoriteBusy, setFavoriteBusy] = useState<string | null>(null);

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

  useEffect(() => {
    // Отказ здесь не ломает каталог: у пользователя может не быть роли
    // инвестора, и тогда отметок просто нет. Каталог обязан открыться и без них.
    api.favorites
      .ids()
      .then((ids) => setFavorites(new Set(ids)))
      .catch(() => setFavorites(new Set()));
  }, []);

  /**
   * Переключение отметки.
   *
   * Состояние читается из СЕРВЕРНОГО ответа, а не выводится из предыдущего:
   * оптимистичное переключение при отказе оставляло бы на экране отметку,
   * которой в базе нет.
   */
  const toggleFavorite = useCallback(
    async (projectId: string) => {
      setFavoriteBusy(projectId);
      const wasFavorite = favorites.has(projectId);
      try {
        const result = wasFavorite
          ? await api.favorites.remove(projectId)
          : await api.favorites.add(projectId);
        setFavorites((current) => {
          const next = new Set(current);
          if (result.favorited) next.add(projectId);
          else next.delete(projectId);
          return next;
        });
      } catch (error) {
        setDetails({
          id: projectId,
          state: 'error',
          message:
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Не удалось изменить избранное',
        });
      } finally {
        setFavoriteBusy(null);
      }
    },
    [favorites],
  );

  /**
   * Полная карточка проекта. Доступ проверяет сервер, а не эта функция.
   *
   * Раньше здесь запрашивался ТОЛЬКО паспорт, и его отсутствие обрывало показ:
   * инвестор жал «Подробнее» и читал «Не найдено» — при живом опубликованном
   * проекте. Паспорт появляется лишь после прогона анализа, поэтому у только
   * что опубликованного проекта его закономерно нет, и это не ошибка.
   *
   * Теперь основа карточки — сам проект, а оценка показывается, если она
   * посчитана. Отказ в доступе к проекту по-прежнему объясняется словами
   * сервера: подписка открывает полную карточку, без неё виден тизер.
   */
  const openDetails = useCallback(async (id: string) => {
    setDetails({ id, state: 'loading' });
    try {
      const project = await api.projects.get(id);
      // Паспорт — необязательная часть: его отсутствие не должно рушить карточку.
      const passport = await api.projects.passport(id).catch(() => null);
      setDetails({ id, state: 'ready', project, passport });
    } catch (error) {
      setDetails({
        id,
        state: 'error',
        message:
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
                <Badge tone="accent">{STAGE_TITLES[teaser.stage] ?? teaser.stage}</Badge>
                <strong style={{ fontSize: 'var(--u-text-lg)' }}>{teaser.title}</strong>
                {teaser.tagline ? (
                  <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {teaser.tagline}
                  </span>
                ) : null}
                <span style={{ fontWeight: 600 }}>
                  {formatMoney(teaser.investmentAsk, teaser.askCurrency)}
                </span>
                <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                  <Button variant="secondary" onClick={() => void openDetails(teaser.id)}>
                    Подробнее
                  </Button>
                  {/*
                    Состояние отметки объявлено ТЕКСТОМ и `aria-pressed`, а не
                    только цветом звезды: «жёлтая звезда = в избранном» не
                    существует для того, кто пользуется экранным диктором.
                  */}
                  <Button
                    variant={favorites.has(teaser.id) ? 'primary' : 'secondary'}
                    aria-pressed={favorites.has(teaser.id)}
                    loading={favoriteBusy === teaser.id}
                    disabled={favoriteBusy === teaser.id}
                    onClick={() => void toggleFavorite(teaser.id)}
                  >
                    {favorites.has(teaser.id) ? '★ В избранном' : '☆ В избранное'}
                  </Button>
                </div>
                {details?.id === teaser.id ? (
                  <div
                    role="status"
                    style={{
                      display: 'grid',
                      gap: 'var(--u-space-2)',
                      padding: 'var(--u-space-3)',
                      borderRadius: 'var(--u-radius-md)',
                      background: 'var(--u-bg-inset)',
                      fontSize: 'var(--u-text-sm)',
                    }}
                  >
                    {details.state === 'loading' ? 'Загружаем…' : null}
                    {details.state === 'error' ? details.message : null}
                    {details.state === 'ready' ? (
                      <>
                        {details.project.description ? (
                          <p style={{ margin: 0, whiteSpace: 'pre-line' }}>
                            {details.project.description}
                          </p>
                        ) : (
                          <span style={{ color: 'var(--u-text-muted)' }}>
                            Основатель пока не добавил подробное описание.
                          </span>
                        )}
                        <dl style={{ display: 'grid', gap: 'var(--u-space-1)', margin: 0 }}>
                          <DetailRow label="Стадия">
                            {STAGE_TITLES[details.project.stage] ?? details.project.stage}
                          </DetailRow>
                          <DetailRow label="Запрос">
                            {formatMoney(
                              details.project.investmentAsk,
                              details.project.askCurrency,
                            )}
                          </DetailRow>
                          {details.project.geoCountry ? (
                            <DetailRow label="География">
                              {details.project.geoCountry}
                              {details.project.geoRegion ? `, ${details.project.geoRegion}` : ''}
                            </DetailRow>
                          ) : null}
                          <DetailRow label="Оценка платформы">
                            {details.passport?.irs
                              ? `IRS ${details.passport.irs.value} (паспорт версии ${details.passport.version})`
                              : 'ещё не рассчитана — проект не проходил анализ'}
                          </DetailRow>
                        </dl>
                      </>
                    ) : null}
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
