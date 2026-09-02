import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Container,
  Icon,
  IconTile,
  LoadingState,
  NovaTopBar,
  OfflineBanner,
  Stack,
  UI_KEYFRAMES,
} from '@unicorn/ui';
import type {
  CreateSupportTicketRequest,
  CurrentUser,
  SupportTicketStatus,
} from '@unicorn/contracts';
import { ApiError, api, setCsrf } from './api';
import { CatalogPage } from './pages/CatalogPage';
import { ProjectDetailsPage } from './pages/ProjectDetailsPage';
import { FavoritesPage } from './pages/FavoritesPage';
import { SubscriptionPage } from './pages/SubscriptionPage';
import { OffersPage } from './pages/OffersPage';
import { BillingPage } from './pages/BillingPage';
import {
  BugReportWidget,
  BusinessEntitiesCard,
  NotificationsCard,
  SupportCard,
  decideAccess,
  hrefFor,
} from '@unicorn/cabinet';
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
type Tab =
  | 'catalog'
  | 'subscription'
  | 'billing'
  | 'verification'
  | 'offers'
  | 'notifications'
  | 'favorites'
  | 'support';

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
  addMember: (entityId: string, body: AddEntityMemberRequest) => api.kyc.addMember(entityId, body),
  startKyb: (entityId: string, kind: 'registry_check' | 'beneficial_owners') =>
    api.kyc.startKyb(entityId, kind),
};

/**
 * Транспорт поддержки и сообщений об ошибках.
 *
 * Тот же приём, что у уведомлений: общий пакет кабинетов не знает про HTTP, а
 * кабинет остаётся при своём клиенте и своей схеме аутентификации.
 */
const supportPort = {
  list: () => api.support.list(),
  detail: (id: string) => api.support.detail(id),
  open: (input: { subject: string; body: string }) =>
    api.support.open({ kind: 'support' as const, ...input }),
  reply: (id: string, body: string) => api.support.reply(id, body),
  update: (id: string, input: { status?: SupportTicketStatus; assignToMe?: boolean }) =>
    api.support.update(id, input),
};

/**
 * Версия сборки, подставленная Vite (`define`). Объявляется здесь, потому что
 * в браузере такой переменной нет — она заменяется значением при сборке.
 */
declare const __APP_VERSION__: string;

/**
 * Порты приложений стенда, подставленные Vite. Нужны только при прямом запуске
 * dev-сервером: за единой точкой входа переход идёт по пути, без портов.
 */
declare const __CABINET_PORTS__: Partial<
  Record<'lab' | 'investor' | 'expert' | 'admin' | 'login', number>
>;


/** Сообщение об ошибке уходит тем же маршрутом — различает их вид обращения. */
const bugReportPort = {
  open: (input: CreateSupportTicketRequest) => api.support.open(input),
};

export default function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>('catalog');
  /**
   * Открытая карточка проекта.
   *
   * Живёт рядом с вкладкой, а не внутри каталога: возврат «к каталогу» обязан
   * приводить в тот же список, а переход на другую вкладку — закрывать карточку.
   */
  const [openProject, setOpenProject] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const profile = await api.auth.me();
      // Кабинет открывается только своей роли: до этого войти здесь мог кто
      // угодно и остаться в чужом разделе, где сервер отвечает отказом.
      const decision = decideAccess(profile.roles, 'investor');
      if (decision.kind !== 'allowed') {
        const target = decision.kind === 'elsewhere' ? decision.to : 'login';
        window.location.replace(hrefFor(target, __CABINET_PORTS__));
        return;
      }
      setMe(profile);
    } catch (error) {
      // 401 — не ошибка, а отсутствие сессии: человека ждёт единый вход.
      // Своей формы у кабинета больше нет, оставлять его здесь незачем.
      if (error instanceof ApiError && error.status === 401) {
        window.location.replace(hrefFor('login', __CABINET_PORTS__));
        return;
      }
      console.warn('профиль не получен', error);
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
      <NovaTopBar
        title="UNICORN LAUNCH"
        subtitle="Кабинет инвестора"
        icon="chart"
        actions={
          me ? (
            <>
              {/* Имя — справка, оно уступает место действию на узком экране. */}
              <span
                className="u-hide-narrow"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--u-space-2)',
                  color: 'var(--u-text-muted)',
                  fontSize: 'var(--u-text-sm)',
                }}
              >
                <IconTile name="user" size={32} />
                {me.displayName}
              </span>
              <Button
                variant="secondary"
                onClick={async () => {
                  await api.auth.logout().catch(() => undefined);
                  setCsrf(null);
                  setMe(null);
                  // Своей формы входа у кабинета больше нет — уводим на общий
                  // экран, иначе останется пустой каркас чужого раздела.
                  window.location.replace(hrefFor('login', __CABINET_PORTS__));
                }}
              >
                <Icon name="logout" size={16} />
                Выйти
              </Button>
            </>
          ) : null
        }
      />
      {/*
        Разделы вынесены из шапки в свою полосу: шести вкладкам рядом с именем
        и выходом тесно уже на ноутбуке, а перенос строки внутри шапки ломал её
        высоту. Здесь они переносятся, не задевая ничего вокруг.
      */}
      {me ? (
        <div style={{ borderBottom: '1px solid var(--u-border)', background: 'var(--u-surface)' }}>
          <Container>
            <nav
              aria-label="Разделы"
              style={{
                display: 'flex',
                gap: 'var(--u-space-2)',
                flexWrap: 'wrap',
                padding: 'var(--u-space-2) 0',
              }}
            >
              <TabButton
                active={tab === 'catalog'}
                onClick={() => {
                  setTab('catalog');
                  setOpenProject(null);
                }}
              >
                Каталог
              </TabButton>
              <TabButton
                active={tab === 'favorites'}
                onClick={() => {
                  setTab('favorites');
                  setOpenProject(null);
                }}
              >
                Избранное
              </TabButton>
              <TabButton
                active={tab === 'subscription'}
                onClick={() => {
                  setTab('subscription');
                  setOpenProject(null);
                }}
              >
                Подписка
              </TabButton>
              <TabButton
                active={tab === 'billing'}
                onClick={() => {
                  setTab('billing');
                  setOpenProject(null);
                }}
              >
                Счета
              </TabButton>
              <TabButton
                active={tab === 'verification'}
                onClick={() => {
                  setTab('verification');
                  setOpenProject(null);
                }}
              >
                Верификация
              </TabButton>
              <TabButton
                active={tab === 'notifications'}
                onClick={() => {
                  setTab('notifications');
                  setOpenProject(null);
                }}
              >
                Уведомления
              </TabButton>
              <TabButton
                active={tab === 'offers'}
                onClick={() => {
                  setTab('offers');
                  setOpenProject(null);
                }}
              >
                Предложения
              </TabButton>
              <TabButton
                active={tab === 'support'}
                onClick={() => {
                  setTab('support');
                  setOpenProject(null);
                }}
              >
                Поддержка
              </TabButton>
            </nav>
          </Container>
        </div>
      ) : null}

      <main id="content">
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && me && tab === 'catalog' && openProject === null ? (
            <CatalogPage onOpen={(id) => setOpenProject(id)} />
          ) : null}
          {!checking && me && tab === 'catalog' && openProject !== null ? (
            <ProjectDetailsPage projectId={openProject} onBack={() => setOpenProject(null)} />
          ) : null}
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
          {!checking && me && tab === 'favorites' ? <FavoritesPage /> : null}
          {!checking && me && tab === 'support' ? <SupportCard port={supportPort} /> : null}
        </Container>
      </main>
      {/*
        Форма сообщения об ошибке доступна везде и всегда, а не на отдельной
        странице: о проблеме сообщают там, где её увидели. Комбинация клавиш —
        для тестировщика, малозаметная кнопка — для всех остальных.
      */}
      {me ? <BugReportWidget port={bugReportPort} appVersion={__APP_VERSION__} /> : null}
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
        borderRadius: 'var(--u-radius-pill)',
        border: 'none',
        // Активная вкладка — брендовая «таблетка»; остальные не соревнуются с
        // ней за внимание и остаются прозрачными.
        background: active ? 'var(--u-brand-gradient, var(--u-accent))' : 'transparent',
        color: active ? '#ffffff' : 'var(--u-text-muted)',
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

