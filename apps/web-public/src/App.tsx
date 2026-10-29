import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  EmptyState,
  ErrorState,
  IconTile,
  Input,
  LoadingState,
  OfflineBanner,
  Skeleton,
  Stack,
  UI_KEYFRAMES,
} from '@unicorn/ui';
import { ProjectCard } from '@unicorn/cabinet';
import type { LandingBlock, ProjectTeaser } from '@unicorn/contracts';
import { api, mediaUrl } from './api';
import { useAsync } from './useAsync';

/**
 * Публичная витрина.
 *
 * Показывает ТОЛЬКО то, что платформа отдаёт анониму: тексты витрины и тизеры
 * листингов. Ни одной выдуманной цифры и ни одного демонстрационного
 * проекта здесь нет — витрина с нарисованными «стартапами» вводит в
 * заблуждение ровно тех, ради кого она сделана.
 *
 * Каждый блок проходит все состояния: загрузка со скелетом, пустота с
 * объяснением, ошибка с действием восстановления. Отсутствие данных — это
 * тоже ответ, и его надо показать словами.
 */
export default function App() {
  // Адрес вида `/p/<id>` открывает страницу проекта. Маршрутизатора здесь нет
  // намеренно: витрина — две страницы, и библиотека ради одной ветки означала
  // бы лишнюю зависимость на самой посещаемой странице продукта.
  const projectId = projectIdFromPath(window.location.pathname);

  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      <a className="u-skip-link" href="#content">
        Перейти к содержимому
      </a>
      <OfflineBanner />
      <Header />
      <main id="content">
        {projectId ? (
          <ProjectPage id={projectId} />
        ) : (
          <>
            <Hero />
            <CatalogSection />
          </>
        )}
      </main>
      <Footer />
    </>
  );
}

/** `/p/<uuid>` → идентификатор; всё остальное → главная. */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/p\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(
    pathname,
  );
  return match?.[1] ?? null;
}

function Header() {
  return (
    <header
      style={{
        borderBottom: '1px solid var(--u-border)',
        background: 'var(--u-surface)',
        position: 'sticky',
        top: 0,
        zIndex: 10,
      }}
    >
      <Container
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 64,
          gap: 'var(--u-space-3)',
          // Перенос обязателен: с появлением кнопок входа шапка
          // перестала помещаться на узком экране и давала горизонтальную
          // прокрутку всей страницы (поймано рендер-проверкой на 390px).
          flexWrap: 'wrap',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--u-space-3)' }}>
          <IconTile name="rocket" variant="solid" size={40} />
          <strong style={{ fontSize: 'var(--u-text-lg)', letterSpacing: '-0.02em' }}>
            Пятый элемент
          </strong>
        </span>
        <nav
          aria-label="Основная навигация"
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 'var(--u-space-3)',
          }}
        >
          <a href="#catalog" style={linkStyle}>
            Каталог
          </a>
          {/*
            Вход — ССЫЛКА на отдельное приложение, а не форма здесь. Витрина
            анонимна по построению (`auth: { kind: 'none' }` в api.ts):
            появление на ней сессии означало бы, что публичная страница начала
            работать с чужими данными. Куда идти после входа, решает роль,
            полученная от сервера, — поэтому кабинет в ссылке не указан.

            Кнопка одна: отдельная «Регистрация» рядом со «Войти» дублировала
            путь — на форме входа есть переключатель «Ещё нет аккаунта? →
            Зарегистрироваться». Прямой адрес `/login/#register` приложение
            входа по-прежнему понимает.
          */}
          <a href="/login/#login" style={primaryStyle}>
            Войти
          </a>
        </nav>
      </Container>
    </header>
  );
}

const linkStyle: React.CSSProperties = {
  color: 'var(--u-text)',
  textDecoration: 'none',
  fontSize: 'var(--u-text-sm)',
  fontWeight: 600,
};

/** Вход — основное действие витрины, поэтому выделен, а не просто ссылка. */
const primaryStyle: React.CSSProperties = {
  ...linkStyle,
  // Не меньше 44px по высоте области нажатия — основная цель на телефоне.
  display: 'inline-flex',
  alignItems: 'center',
  minHeight: 44,
  padding: '0 var(--u-space-4)',
  borderRadius: 'var(--u-radius-pill)',
  // Градиент темы с запасным сплошным акцентом: без темы переменной нет, и
  // кнопка обязана остаться кнопкой, а не прозрачным местом.
  background: 'var(--u-brand-gradient, var(--u-accent))',
  fontWeight: 700,
  // Токена «контрастный к акценту» в наборе нет; акцент и градиент в обеих
  // темах насыщенные, на них читается белый.
  color: '#fff',
};

/**
 * Тексты витрины на случай, когда контент ещё не опубликован или API недоступен.
 *
 * Не «дефолтные значения ради удобства»: витрина — публичная страница, и пустое
 * место на ней хуже устаревшей формулировки. Как только администратор
 * публикует блок, показывается он, а эти строки перестают использоваться.
 * Держать их здесь — сознательный дубликат, и он единственный.
 */
const FALLBACK: Record<string, { title?: string; body: string }> = {
  hero_title: { body: 'Платформа проектов и людей вокруг них' },
  hero_subtitle: {
    body:
      'Основатели рассказывают о своих проектах и сами решают, кому их открыть. ' +
      'Возможности для инвесторов прорабатываются заново.',
  },
  disclaimer: {
    body: '«Пятый элемент» не проводит инвестиционных сделок и не принимает платежей.',
  },
};

/** Текст блока: опубликованный, иначе запасной. */
function blockText(blocks: LandingBlock[] | null, key: string): string {
  return blocks?.find((b) => b.key === key)?.body ?? FALLBACK[key]?.body ?? '';
}

function Hero() {
  // Ошибка загрузки контента НЕ ломает витрину и не показывается посетителю:
  // он пришёл читать про платформу, а не про состояние нашего API. Каталог
  // ведёт себя иначе — там пустой экран означал бы неверные
  // сведения, а здесь достаточно запасного текста.
  const { state } = useAsync<LandingBlock[]>(() => api.landingContent(), []);
  const blocks = state.status === 'ready' ? state.data : null;

  return (
    <section style={{ padding: 'var(--u-space-8) 0', background: 'var(--u-bg-subtle)' }}>
      <Container>
        <Stack gap="var(--u-space-5)" style={{ maxWidth: 720 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 'var(--u-text-2xl)',
              lineHeight: 'var(--u-leading-tight)',
              letterSpacing: '-0.03em',
            }}
          >
            {blockText(blocks, 'hero_title')}
          </h1>
          <p style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-lg)' }}>
            {blockText(blocks, 'hero_subtitle')}
          </p>
        </Stack>
      </Container>
    </section>
  );
}

function CatalogSection() {
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const filter = useMemo(() => (applied ? { q: applied } : {}), [applied]);

  const { state, reload } = useAsync(() => api.catalog({ ...filter, limit: 12 }), [applied]);

  return (
    <section id="catalog" style={{ padding: 'var(--u-space-7) 0' }}>
      <Container>
        <Stack gap="var(--u-space-5)">
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Проекты в каталоге</h2>
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              Тизеры доступны всем. Что открыто сверх тизера, решает основатель проекта.
            </span>
          </div>

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

          {state.status === 'loading' ? <CatalogSkeleton /> : null}

          {state.status === 'error' ? (
            <ErrorState
              description={state.message}
              traceId={state.traceId}
              onRetry={reload}
            />
          ) : null}

          {state.status === 'ready' && state.data.items.length === 0 ? (
            <EmptyState
              title={applied ? 'Ничего не найдено' : 'В каталоге пока пусто'}
              description={
                applied
                  ? 'Попробуйте другой запрос: поиск идёт по названию и описанию проекта.'
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

          {state.status === 'ready' && state.data.items.length > 0 ? (
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
              {state.data.items.map((teaser) => (
                <li key={teaser.id}>
                  <TeaserCard teaser={teaser} />
                </li>
              ))}
            </ul>
          ) : null}
        </Stack>
      </Container>
    </section>
  );
}

function TeaserCard({ teaser }: { teaser: ProjectTeaser }) {
  return (
    <Card style={{ height: '100%', display: 'grid', gap: 'var(--u-space-3)' }}>
      <div style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}>
        {teaser.logoUrl ? (
          <img
            data-teaser-logo
            src={mediaUrl(teaser.logoUrl)}
            alt=""
            width={48}
            height={48}
            style={{ width: 48, height: 48, borderRadius: 'var(--u-radius-md)' }}
          />
        ) : null}
        <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
          <Badge tone="accent">{STAGE_LABEL[teaser.stage] ?? teaser.stage}</Badge>
          {teaser.geoCountry ? <Badge>{teaser.geoCountry}</Badge> : null}
        </div>
      </div>
      <strong style={{ fontSize: 'var(--u-text-lg)', lineHeight: 'var(--u-leading-tight)' }}>
        {teaser.title}
      </strong>
      {teaser.tagline ? (
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          {teaser.tagline}
        </span>
      ) : null}
      <a href={`/p/${teaser.id}`} data-teaser-link={teaser.id} style={{ fontWeight: 600 }}>
        Открыть проект
      </a>
    </Card>
  );
}

const STAGE_LABEL: Record<string, string> = {
  idea: 'Идея',
  mvp: 'MVP',
  early_revenue: 'Первая выручка',
  growth: 'Рост',
};

function CatalogSkeleton() {
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'grid',
        gap: 'var(--u-space-4)',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      }}
      aria-hidden="true"
    >
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <li key={index}>
          <Card style={{ display: 'grid', gap: 'var(--u-space-3)' }}>
            <Skeleton height={20} width={80} radius="var(--u-radius-pill)" />
            <Skeleton height={24} />
            <Skeleton height={16} width="70%" />
            <Skeleton height={18} width={120} />
          </Card>
        </li>
      ))}
    </ul>
  );
}

function Footer() {
  const { state } = useAsync<LandingBlock[]>(() => api.landingContent(), []);
  const blocks = state.status === 'ready' ? state.data : null;

  return (
    <footer style={{ borderTop: '1px solid var(--u-border)', padding: 'var(--u-space-6) 0' }}>
      <Container>
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          {blockText(blocks, 'disclaimer')}
        </span>
      </Container>
    </footer>
  );
}

/**
 * Страница проекта на витрине.
 *
 * Показывает ровно ту проекцию, которую отдал сервер (`GET /catalog/:id`,
 * Public View). Второй модели раскрытия здесь нет и быть не должно: что
 * увидит зритель, решает предикат аудитории в базе — режим проекта,
 * адресные разрешения и исключения. Витрина эти правила НЕ повторяет и не
 * угадывает.
 */
function ProjectPage({ id }: { id: string }) {
  const { state, reload } = useAsync(() => api.catalogItem(id), [id]);
  // Изображения запрашиваются отдельно: их наличие проекция каталога не
  // знает, а показывать рамку несуществующей картинки нельзя.
  const media = useAsync(() => api.projectMedia(id).catch(() => ({ items: [] })), [id]);

  if (state.status === 'loading') {
    return (
      <Container>
        <LoadingState label="Загружаем проект" />
      </Container>
    );
  }
  if (state.status === 'error') {
    // Ответ ОДИНАКОВЫЙ для несуществующего и для недоступного проекта.
    //
    // Это не обобщение ради краткости. «Проект снят с публикации» подтверждает
    // постороннему, что проект существует, а иногда и то, что он был
    // опубликован. По разным формулировкам чужой каталог перебирается
    // адресами: одна страница отвечает «нет такого», другая — «есть, но не
    // для вас». Поэтому текст нейтральный, без названия и без намёка на
    // существование.
    return (
      <Container>
        <ErrorState
          title="Страница не найдена"
          description="Проверьте адрес или вернитесь к списку проектов."
          traceId={state.traceId}
          onRetry={reload}
        />
      </Container>
    );
  }

  const view = state.data;
  const items = media.state.status === 'ready' ? media.state.data.items : [];
  const cover = items.find((item) => item.kind === 'cover');
  const logo = items.find((item) => item.kind === 'logo');

  return (
    <Container>
      {/*
        Та же карточка, что в кабинете инвестора и в предпросмотре владельца
        (7.3). Состав решает сервер: витрина спрашивает публичную проекцию, и
        описания, материалов и оценки платформы в ней просто нет — их не
        прячет разметка, их не присылает сервер.
      */}
      <div data-project-page={view.id}>
        <ProjectCard
          surface="public"
          source={{ kind: 'public', view }}
          media={{
            coverUrl: cover?.urls.page ? mediaUrl(cover.urls.page) : null,
            logoUrl: logo?.urls.page ? mediaUrl(logo.urls.page) : null,
          }}
          back={
            <a href="/" style={{ fontSize: 'var(--u-text-sm)' }}>
              ← Ко всем проектам
            </a>
          }
        />
      </div>
    </Container>
  );
}

