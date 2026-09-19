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
  describeRaising,
} from '@unicorn/ui';
import type { LandingBlock, Pricing, ProjectTeaser, Season } from '@unicorn/contracts';
import { api } from './api';
import { useAsync } from './useAsync';

/**
 * Публичная витрина.
 *
 * Показывает ТОЛЬКО то, что платформа отдаёт анониму: тизеры листингов, тарифы
 * и метроном сезона. Ни одной выдуманной цифры и ни одного демонстрационного
 * проекта здесь нет — витрина с нарисованными «стартапами» вводит в
 * заблуждение ровно тех, ради кого она сделана.
 *
 * Каждый блок проходит все состояния: загрузка со скелетом, пустота с
 * объяснением, ошибка с действием восстановления. Отсутствие данных — это
 * тоже ответ, и его надо показать словами.
 */
export default function App() {
  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      <a className="u-skip-link" href="#content">
        Перейти к содержимому
      </a>
      <OfflineBanner />
      <Header />
      <main id="content">
        <Hero />
        <SeasonStrip />
        <CatalogSection />
        <PricingSection />
      </main>
      <Footer />
    </>
  );
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
          // Перенос обязателен: с появлением «Войти» и «Регистрация» шапка
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
          <a href="#pricing" style={linkStyle}>
            Тарифы
          </a>
          {/*
            Вход и регистрация — ССЫЛКИ на отдельное приложение, а не форма
            здесь. Витрина анонимна по построению (`auth: { kind: 'none' }` в
            api.ts): появление на ней сессии означало бы, что публичная
            страница начала работать с чужими данными. Куда идти после входа,
            решает роль, полученная от сервера, — поэтому кабинет в этих
            ссылках не указан.

            Фрагмент (`#login` / `#register`) называет экран приложения входа.
            До Ф60 обе ссылки вели на голый `/login/`, то есть на форму входа:
            кнопка «Регистрация» обещала регистрацию и открывала вход, хотя
            форма регистрации в приложении есть и работает. Фрагмент не уходит
            на сервер — для прокси это по-прежнему один и тот же путь.
          */}
          <a href="/login/#login" style={linkStyle}>
            Войти
          </a>
          <a href="/login/#register" style={registerStyle}>
            Регистрация
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

/** Регистрация — основное действие витрины, поэтому выделена, а не просто ссылка. */
const registerStyle: React.CSSProperties = {
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
  hero_title: { body: 'Инвестиционная платформа для проектов, прошедших проверку' },
  hero_subtitle: {
    body:
      'Основатели проходят экспертизу и получают инвестиционный паспорт. ' +
      'Верифицированные инвесторы видят полные карточки и заключают договоры ' +
      'средствами платформы — движение средств учитывается через номинальный ' +
      'счёт оператора.',
  },
  disclaimer: {
    body:
      '«Пятый элемент» — оператор инвестиционной платформы. Инвестиционный контур ' +
      'включается после включения оператора в реестр Банка России.',
  },
};

/** Текст блока: опубликованный, иначе запасной. */
function blockText(blocks: LandingBlock[] | null, key: string): string {
  return blocks?.find((b) => b.key === key)?.body ?? FALLBACK[key]?.body ?? '';
}

function Hero() {
  // Ошибка загрузки контента НЕ ломает витрину и не показывается посетителю:
  // он пришёл читать про платформу, а не про состояние нашего API. Каталог,
  // цены и сезон ведут себя иначе — там пустой экран означал бы неверные
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

/** Метроном сезона: по нему основатель понимает, открыт ли приём заявок. */
function SeasonStrip() {
  // Никакого `.catch(() => null)`: недоступный сервер и «сезона нет» — разные
  // ответы, и показывать первый как второй значит врать пользователю. `null`
  // приходит от сервера как законное значение, ошибка идёт в состояние ошибки.
  const { state, reload } = useAsync<Season | null>(() => api.currentSeason(), []);

  return (
    <Container style={{ padding: 'var(--u-space-5) 0' }}>
      {state.status === 'loading' ? <Skeleton height={44} radius="var(--u-radius-md)" /> : null}
      {state.status === 'error' ? (
        <ErrorState
          title="Статус сезона недоступен"
          description={state.message}
          traceId={state.traceId}
          onRetry={reload}
        />
      ) : null}
      {/* Сезона нет (в том числе пока сезонный контур отложен, M088) —
          полоса не показывается: обещать «следующий сезон» витрина не может. */}
      {state.status === 'ready' && state.data !== null ? (
        <Card
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--u-space-4)',
            flexWrap: 'wrap',
          }}
        >
          <Badge tone={state.data.status === 'applications_open' ? 'success' : 'neutral'}>
            {SEASON_STATUS_LABEL[state.data.status] ?? state.data.status}
          </Badge>
          <strong>Сезон {state.data.number}</strong>
          {state.data.title ? (
            <span style={{ color: 'var(--u-text-muted)' }}>{state.data.title}</span>
          ) : null}
          <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            до {formatDate(state.data.endsAt)}
          </span>
        </Card>
      ) : null}
    </Container>
  );
}

const SEASON_STATUS_LABEL: Record<string, string> = {
  draft: 'Готовится',
  applications_open: 'Приём заявок открыт',
  review: 'Идёт экспертиза',
  bootcamp: 'Буткемп',
  final: 'Финал',
  closed: 'Завершён',
};

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
              Тизеры доступны всем. Полная карточка — в кабинете инвестора, по режиму, который
              выбрал основатель.
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
      <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
        <Badge tone="accent">{STAGE_LABEL[teaser.stage] ?? teaser.stage}</Badge>
        {teaser.geoCountry ? <Badge>{teaser.geoCountry}</Badge> : null}
      </div>
      <strong style={{ fontSize: 'var(--u-text-lg)', lineHeight: 'var(--u-leading-tight)' }}>
        {teaser.title}
      </strong>
      {teaser.tagline ? (
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          {teaser.tagline}
        </span>
      ) : null}
      <span style={{ fontWeight: 600 }}>{describeRaising(teaser)}</span>
    </Card>
  );
}

const BILLING_PERIOD_LABEL: Record<string, string> = {
  monthly: 'мес.',
  yearly: 'год',
};

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

/**
 * Тарифы и вознаграждение оператора.
 *
 * Показываются полностью и без регистрации: условие, которое человек узнаёт
 * только после оплаты, — не условие, а ловушка.
 */
function PricingSection() {
  const { state, reload } = useAsync<Pricing>(() => api.pricing(), []);

  return (
    <section id="pricing" style={{ padding: 'var(--u-space-7) 0', background: 'var(--u-bg-subtle)' }}>
      <Container>
        <Stack gap="var(--u-space-5)">
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Тарифы и вознаграждение</h2>

          {state.status === 'loading' ? <LoadingState label="Загружаем тарифы" /> : null}
          {state.status === 'error' ? (
            <ErrorState description={state.message} traceId={state.traceId} onRetry={reload} />
          ) : null}

          {state.status === 'ready' ? (
            <>
              {state.data.plans.length === 0 ? (
                <EmptyState
                  title="Тарифы не опубликованы"
                  description="Как только оператор опубликует тарифную сетку, она появится здесь."
                />
              ) : (
                <ul
                  style={{
                    listStyle: 'none',
                    margin: 0,
                    padding: 0,
                    display: 'grid',
                    gap: 'var(--u-space-4)',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                  }}
                >
                  {state.data.plans.map((plan) => (
                    <li key={plan.id}>
                      <Card style={{ height: '100%', display: 'grid', gap: 'var(--u-space-2)' }}>
                        <strong>{plan.name}</strong>
                        <span style={{ fontSize: 'var(--u-text-lg)', fontWeight: 700 }}>
                          {`${formatMoney(plan.price)} / ${BILLING_PERIOD_LABEL[plan.billingPeriod]}`}
                        </span>
                        <span
                          style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}
                        >
                          {/*
                            Тарифы — только для инвестора: основатель платит
                            разово за запуск конкретного раунда (5.9), а не
                            ежемесячно по сумме привлечения.
                          */}
                          Доступ инвестора к полным карточкам
                        </span>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}

              {/*
                Объявленные изменения цен показываются ДО их вступления в силу:
                цена, о которой пользователь узнаёт в момент списания,
                противоречит заявленной прозрачности (Architect_Launch §5.4).
              */}
              {state.data.announcedPlans.length > 0 ? (
                <Card style={{ borderColor: 'var(--u-warning)' }}>
                  <Stack gap="var(--u-space-2)">
                    <strong>Объявленные изменения тарифов</strong>
                    <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)' }}>
                      {state.data.announcedPlans.map((plan) => (
                        <li key={plan.id} style={{ color: 'var(--u-text-muted)' }}>
                          {plan.name}:{' '}
                          {plan.price === null ? 'индивидуально' : formatMoney(plan.price)} — с{' '}
                          {formatDate(plan.validFrom)}
                        </li>
                      ))}
                    </ul>
                  </Stack>
                </Card>
              ) : null}

              <Card>
                <Stack gap="var(--u-space-2)">
                  <strong>Вознаграждение оператора за сделку</strong>
                  <span style={{ color: 'var(--u-text-muted)' }}>
                    Инвестор — {state.data.feeSchedule.investorFeePct}%, эмитент —{' '}
                    {state.data.feeSchedule.issuerFeePct}%. Начисляется после подтверждения
                    первого транша по договору.
                  </span>
                  {/*
                    Обязательное раскрытие: база вознаграждения — ПОЛНАЯ сумма
                    договора, начисление разовое. Показывается до регистрации,
                    а не в момент списания.
                  */}
                  <span style={{ fontSize: 'var(--u-text-sm)' }}>
                    База — полная сумма договора, начисление однократное.{' '}
                    {state.data.feeDisclosure.triggerDescription}
                  </span>
                </Stack>
              </Card>
            </>
          ) : null}
        </Stack>
      </Container>
    </section>
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

/** Деньги приходят строкой и остаются строкой: приведение к number теряет копейки. */
function formatMoney(value: string): string {
  const [whole, fraction] = value.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction && fraction !== '00' ? `${grouped},${fraction} ₽` : `${grouped} ₽`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
