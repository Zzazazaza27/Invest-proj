import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  Stack,
  describeRaising,
} from '@unicorn/ui';
import type { ProjectTeaser } from '@unicorn/contracts';
import { publishedScore10 } from '@unicorn/cabinet';
import { ApiError, api } from '../api';

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

/** Краткая справка для подсказки: описание проекта и оценка платформы. */
type Preview =
  | { state: 'loading' }
  | { state: 'ready'; summary: string | null; irs: number | null }
  | { state: 'unavailable' };

/**
 * Каталог проектов.
 *
 * Инвестор видит те же тизеры, что и аноним: полная карточка открывается
 * подпиской, и это решает СЕРВЕР. Кабинет не пытается угадать доступ и не
 * прячет кнопку «Подробнее» — он отправляет запрос и показывает ответ, включая
 * отказ с объяснением, что нужна подписка.
 *
 * Сетка карточек намеренно жёсткая: у каждой карточки фиксированная раскладка
 * строк и ряд кнопок, прижатый к низу. Раньше подробности раскрывались внутри
 * карточки, и при нажатии соседние карточки уезжали вниз — человек терял
 * место, на которое смотрел. Теперь «Подробнее» открывает отдельную страницу, а
 * подсказка при наведении показывается поверх сетки и на поток не влияет.
 */
export function CatalogPage({ onOpen }: { onOpen: (projectId: string) => void }) {
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; items: ProjectTeaser[] }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);
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
  const [hovered, setHovered] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  /** Уже запрошенные справки: подсказка не должна дёргать сеть на каждое наведение. */
  const requested = useRef<Set<string>>(new Set());

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
   * Справка для подсказки при наведении.
   *
   * Тянется один раз на проект и только по наведению: грузить сотню паспортов
   * при открытии каталога ради подсказки, которую, может быть, никто не
   * увидит, — расход впустую.
   */
  const ensurePreview = useCallback((projectId: string) => {
    if (requested.current.has(projectId)) return;
    requested.current.add(projectId);
    setPreviews((current) => ({ ...current, [projectId]: { state: 'loading' } }));
    void Promise.all([
      api.projects.get(projectId).catch(() => null),
      api.projects.passport(projectId).catch(() => null),
    ]).then(([project, passport]) => {
      if (!project && !passport) {
        setPreviews((current) => ({ ...current, [projectId]: { state: 'unavailable' } }));
        return;
      }
      const description = project?.description ?? null;
      setPreviews((current) => ({
        ...current,
        [projectId]: {
          state: 'ready',
          summary: description ? shorten(description, 220) : null,
          // Публикуемый балл — после решения человека по потолкам; у старых
          // паспортов без него — из IRS по таблице.
          irs:
            passport === null
              ? null
              : (publishedScore10(passport) ?? Math.round((passport.irs?.value ?? 0) / 10)),
        },
      }));
    });
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
      setNotice(null);
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
        setNotice(
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Не удалось изменить избранное',
        );
      } finally {
        setFavoriteBusy(null);
      }
    },
    [favorites],
  );

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

      {notice ? (
        <div
          role="alert"
          style={{
            padding: 'var(--u-space-3) var(--u-space-4)',
            borderRadius: 'var(--u-radius-md)',
            background: 'var(--u-danger-subtle)',
            color: 'var(--u-danger)',
          }}
        >
          {notice}
        </div>
      ) : null}

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
            alignItems: 'stretch',
          }}
        >
          {state.items.map((teaser) => (
            <li key={teaser.id} style={{ position: 'relative' }}>
              <Card
                style={{
                  height: '100%',
                  display: 'grid',
                  /*
                    Пять строк с заранее назначенными ролями: метка, название,
                    подзаголовок, сумма и ряд кнопок. Ряд кнопок стоит в
                    последней строке (`1fr` над ним съедает остаток), поэтому
                    кнопки всех карточек в ряду находятся на одной высоте
                    независимо от длины подзаголовка.
                  */
                  gridTemplateRows: 'auto auto auto 1fr auto',
                  gap: 'var(--u-space-3)',
                }}
              >
                <Badge tone="accent">{STAGE_TITLES[teaser.stage] ?? teaser.stage}</Badge>
                <strong style={{ fontSize: 'var(--u-text-lg)' }}>{teaser.title}</strong>
                <span
                  style={{
                    color: 'var(--u-text-muted)',
                    fontSize: 'var(--u-text-sm)',
                    /* Ровно две строки: карточки не расходятся по высоте. */
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    minHeight: '2.6em',
                  }}
                >
                  {teaser.tagline ?? ''}
                </span>
                <span style={{ fontWeight: 600, alignSelf: 'end' }}>{describeRaising(teaser)}</span>
                <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                  <div
                    style={{ position: 'relative' }}
                    onMouseEnter={() => {
                      setHovered(teaser.id);
                      ensurePreview(teaser.id);
                    }}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => {
                      setHovered(teaser.id);
                      ensurePreview(teaser.id);
                    }}
                    onBlur={() => setHovered(null)}
                  >
                    <Button variant="secondary" onClick={() => onOpen(teaser.id)}>
                      Подробнее
                    </Button>
                    {hovered === teaser.id ? (
                      <PreviewPopover preview={previews[teaser.id] ?? { state: 'loading' }} />
                    ) : null}
                  </div>
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
              </Card>
            </li>
          ))}
        </ul>
      ) : null}
    </Stack>
  );
}

/**
 * Подсказка при наведении: о чём проект и как его оценила платформа.
 *
 * Абсолютное позиционирование обязательно — подсказка не участвует в потоке и
 * не сдвигает соседние карточки. Роль `tooltip` и `aria-live` дают её тем, кто
 * не пользуется мышью.
 */
function PreviewPopover({ preview }: { preview: Preview }) {
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        /*
          Подсказка раскрывается ВНИЗ, а не вверх: всплывая над кнопкой, она
          закрывала название и сумму той самой карточки, о которой
          рассказывает. Снизу она ложится поверх соседнего ряда — там ничего
          сейчас не читают.
        */
        top: 'calc(100% + var(--u-space-2))',
        left: 0,
        zIndex: 20,
        width: 'min(22rem, 80vw)',
        padding: 'var(--u-space-3) var(--u-space-4)',
        borderRadius: 'var(--u-radius-md)',
        border: '1px solid var(--u-border)',
        background: 'var(--u-surface)',
        boxShadow: 'var(--u-shadow-md, 0 8px 24px rgba(0,0,0,0.18))',
        fontSize: 'var(--u-text-sm)',
        lineHeight: 1.5,
        display: 'grid',
        gap: 'var(--u-space-2)',
      }}
    >
      {preview.state === 'loading' ? <span>Загружаем краткую справку…</span> : null}
      {preview.state === 'unavailable' ? (
        <span style={{ color: 'var(--u-text-muted)' }}>
          Подробности откроются по подписке — нажмите «Подробнее».
        </span>
      ) : null}
      {preview.state === 'ready' ? (
        <>
          <span>{preview.summary ?? 'Основатель пока не добавил подробное описание.'}</span>
          <strong>
            {preview.irs === null
              ? 'Оценка платформы ещё не рассчитана'
              : `Оценка платформы: ${preview.irs}/10 · сгенерирована ИИ, сведения не проверялись`}
          </strong>
        </>
      ) : null}
    </div>
  );
}

/** Обрезка по границе слова: обрубленное на середине слова читается как сбой. */
function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 40 ? lastSpace : limit)}…`;
}
