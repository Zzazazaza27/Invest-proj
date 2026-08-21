import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Container,
  Field,
  Input,
  LoadingState,
  OfflineBanner,
  Stack,
  UI_KEYFRAMES,
} from '@unicorn/ui';
import type { CurrentUser } from '@unicorn/contracts';
import { ApiError, api, setCsrf } from './api';
import { CatalogPage } from './pages/CatalogPage';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { OffersPage } from './pages/OffersPage';
import { BillingPage } from './pages/BillingPage';
import { BusinessEntitiesCard, NotificationsCard } from '@unicorn/cabinet';
import type {
  AddEntityMemberRequest,
  CreateEntityRequest,
  NotificationPreference,
} from '@unicorn/contracts';
import { VerificationPage } from './pages/VerificationPage';

/**
 * Кабинет инвестора.
 *
 * Три вкладки соответствуют трём состояниям инвестора на платформе: что он
 * может посмотреть (каталог), что открывает подписка и что происходит в
 * регулируемом контуре. Последний выключен фичефлагом до включения оператора в
 * реестр ОИП — и кабинет говорит об этом прямо, а не показывает пустой список,
 * из которого можно заключить «предложений нет».
 */
type Tab = 'catalog' | 'subscription' | 'billing' | 'verification' | 'offers' | 'notifications';

/**
 * Короткое имя входа дополняется внутренним доменом.
 *
 * Тестовые и служебные учётные записи заводятся как `имя@unicorn.local`, но
 * человек вводит просто `имя`. Отдельного поля «логин» в схеме нет и заводить
 * его ради удобства входа не стоит, поэтому подстановка живёт на границе
 * интерфейса — сервер по-прежнему получает адрес и о ней ничего не знает.
 *
 * То же правило действует в админке: расхождение между кабинетами выглядело бы
 * как «в одном вход работает, в другом нет».
 */
const INTERNAL_DOMAIN = 'unicorn.local';

function toAddress(input: string): string {
  const value = input.trim();
  return value.includes('@') ? value : `${value}@${INTERNAL_DOMAIN}`;
}


/**
 * Транспорт для общих блоков кабинета.
 *
 * Пакет `@unicorn/cabinet` намеренно не знает про HTTP: сюда передаются три
 * функции, и граница «в сеть — только через свой клиент» видна в сигнатуре.
 */
const notificationsPort = {
  list: (limit: number) => api.notifications.list({ limit }),
  preferences: () => api.notifications.preferences(),
  savePreferences: (items: NotificationPreference[]) => api.notifications.updatePreferences(items),
};


/**
 * Транспорт для карточки юрлиц. Тот же приём, что и у уведомлений: пакет не
 * знает про HTTP, а кабинет остаётся при своём клиенте.
 */
const entitiesPort = {
  list: () => api.kyc.entities(),
  create: (body: CreateEntityRequest) => api.kyc.createEntity(body),
  addMember: (entityId: string, body: AddEntityMemberRequest) =>
    api.kyc.addMember(entityId, body),
  startKyb: (entityId: string, kind: 'registry_check' | 'beneficial_owners') =>
    api.kyc.startKyb(entityId, kind),
};

export default function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('catalog');

  const load = useCallback(async () => {
    try {
      setMe(await api.auth.me());
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.warn('профиль не получен', error);
      }
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      <a className="u-skip-link" href="#content">
        Перейти к содержимому
      </a>
      <OfflineBanner />
      <header style={{ borderBottom: '1px solid var(--u-border)', background: 'var(--u-surface)' }}>
        <Container
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            minHeight: 64,
            gap: 'var(--u-space-4)',
            flexWrap: 'wrap',
          }}
        >
          <strong>Кабинет инвестора</strong>
          {me ? (
            <>
              {/*
                Разделов четыре, и на узком экране они перестают помещаться в
                строку. Перенос вместо горизонтальной прокрутки страницы:
                прокрутка увела бы вправо весь кабинет, а не только меню.
              */}
              <nav
                aria-label="Разделы"
                style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}
              >
                <TabButton active={tab === 'catalog'} onClick={() => setTab('catalog')}>
                  Каталог
                </TabButton>
                <TabButton active={tab === 'subscription'} onClick={() => setTab('subscription')}>
                  Подписка
                </TabButton>
                <TabButton active={tab === 'billing'} onClick={() => setTab('billing')}>
                  Счета
                </TabButton>
                <TabButton active={tab === 'verification'} onClick={() => setTab('verification')}>
                  Верификация
                </TabButton>
                <TabButton active={tab === 'notifications'} onClick={() => setTab('notifications')}>
                  Уведомления
                </TabButton>
                <TabButton active={tab === 'offers'} onClick={() => setTab('offers')}>
                  Предложения
                </TabButton>
              </nav>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--u-space-3)' }}>
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                  {me.displayName}
                </span>
                <Button
                  variant="secondary"
                  onClick={async () => {
                    await api.auth.logout().catch(() => undefined);
                    setCsrf(null);
                    setMe(null);
                  }}
                >
                  Выйти
                </Button>
              </div>
            </>
          ) : null}
        </Container>
      </header>

      <main id="content">
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && !me ? <LoginPage onLoggedIn={() => void load()} /> : null}
          {!checking && me && tab === 'catalog' ? <CatalogPage /> : null}
          {!checking && me && tab === 'subscription' ? <SubscriptionPage /> : null}
          {!checking && me && tab === 'billing' ? <BillingPage /> : null}
          {!checking && me && tab === 'verification' ? (
            <Stack gap="var(--u-space-6)">
              <VerificationPage />
              {/*
                Инвестор участвует в сделке лично или от компании. Второй путь
                требует проверенного юрлица — и это часть той же верификации, а
                не отдельный раздел.
              */}
              <BusinessEntitiesCard port={entitiesPort} />
            </Stack>
          ) : null}
          {!checking && me && tab === 'offers' ? <OffersPage /> : null}
          {!checking && me && tab === 'notifications' ? (
            <NotificationsCard port={notificationsPort} />
          ) : null}
        </Container>
      </main>
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      // Текущий раздел объявляется ассистивным технологиям, а не только цветом.
      aria-current={active ? 'page' : undefined}
      style={{
        minHeight: 44,
        padding: '0 var(--u-space-4)',
        borderRadius: 'var(--u-radius-md)',
        border: 'none',
        background: active ? 'var(--u-accent-subtle)' : 'transparent',
        color: active ? 'var(--u-accent)' : 'var(--u-text)',
        font: 'inherit',
        fontWeight: 600,
        fontSize: 'var(--u-text-sm)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card style={{ maxWidth: 420, margin: '0 auto' }}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const session = await api.auth.login({ email: toAddress(email), password });
            setCsrf(session.csrfToken ?? null);
            onLoggedIn();
          } catch (caught) {
            // Причина 401 наружу НЕ раскрывается: текст сервера отличает
            // «нет такого пользователя» от «неверный пароль» и превращает
            // форму входа в перечислитель учёток. Для остальных ошибок
            // (например, требуется повторный акцепт условий) текст полезен и
            // сохраняется. Admin вёл себя так с самого начала — расхождение
            // копий кабинетов (аудит №2).
            setError(
              caught instanceof ApiError
                ? caught.status === 401
                  ? 'Неверные данные для входа'
                  : (caught.problem?.detail ?? caught.message)
                : 'Сервис недоступен',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Stack>
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Вход</h1>
          <Field
            label="Почта или логин"
            htmlFor="email"
            hint="Короткое имя дополняется доменом автоматически"
          >
            <Input
              id="email"
              // Не type="email": короткое имя без @ браузер отверг бы до отправки.
              type="text"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </Field>
          <Field label="Пароль" htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          {error ? (
            <div role="alert" style={{ color: 'var(--u-danger)', fontSize: 'var(--u-text-sm)' }}>
              {error}
            </div>
          ) : null}
          <Button type="submit" loading={busy}>
            Войти
          </Button>
        </Stack>
      </form>
    </Card>
  );
}
