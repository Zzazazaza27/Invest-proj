import { useState } from 'react';
import {
  Button,
  Container,
  EmptyState,
  Icon,
  LoadingState,
  NovaTopBar,
  OfflineBanner,
  UI_KEYFRAMES,
} from '@fifth/ui';
import type { CurrentUser } from '@fifth/contracts';
import {
  ProfileLink,
  ProfilePage,
  SessionCheckFailed,
  TestContextBanner,
  decideAccess,
  goToLogin,
  hrefFor,
  useSessionCheck,
  type ProfilePort,
} from '@fifth/cabinet';
import { api, setCsrf, testContextId, testContextPort } from './api';

/**
 * «Мой профиль» — тот же общий экран профиля аккаунта, что у основателя (Тэнк, 09.11:
 * временное размещение до проработки блока 03, без отдельного инвесторского профиля).
 * Маршрутизатора в оболочке нет: nginx отдаёт index.html на любой путь под /investor/,
 * поэтому прямое открытие /investor/profile работает, а ссылка из шапки — обычный переход.
 */
const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, '');
const PROFILE_HREF = `${BASE_PATH}/profile`;
const onProfilePage = () => window.location.pathname.replace(/\/+$/, '') === PROFILE_HREF;

const profilePort: ProfilePort = {
  features: () => api.features(),
  load: () => api.profile.me(),
  updateName: (displayName) => api.profile.updateName(displayName),
  uploadAvatar: (file) => api.profile.uploadAvatar(file),
  removeAvatar: () => api.profile.removeAvatar(),
  changePassword: async (input) => {
    await api.profile.changePassword(input);
  },
  emailVerification: {
    status: () => api.auth.emailVerificationStatus(),
    request: (idempotencyKey) => api.auth.requestEmailVerification({ idempotencyKey }),
  },
};

/**
 * Кабинет инвестора — пустая оболочка.
 *
 * Прежний кабинет (каталог с подпиской, счета, предложения, сделки) удалён
 * вместе с инвестиционным процессом в 2.1-W05. Новый будет проработан
 * отдельно; до тех пор здесь только вход по роли, выход и честное «в
 * разработке» — без экранов, за которыми нет работающих функций.
 */

/**
 * Порты приложений стенда, подставленные Vite. Нужны только при прямом запуске
 * dev-сервером: за единой точкой входа переход идёт по пути, без портов.
 */
declare const __CABINET_PORTS__: Partial<Record<'lab' | 'investor' | 'admin' | 'login', number>>;

export default function App() {
  const [me, setMe] = useState<CurrentUser | null>(null);

  // 401 и временная неудача проверки — разные вещи: 429 на `GET /v1/auth/me`
  // не должен выглядеть как выход из аккаунта.
  const { checking, failure, retry } = useSessionCheck(() => api.auth.me(), {
    onReady: (profile) => {
      // Кабинет открывается только своей роли.
      const decision = decideAccess(profile.roles, 'investor');
      if (decision.kind !== 'allowed') {
        const target = decision.kind === 'elsewhere' ? decision.to : 'login';
        window.location.replace(hrefFor(target, __CABINET_PORTS__));
        return false;
      }
      setMe(profile);
      return true;
    },
    onAbsent: () => {
      window.location.replace(hrefFor('login', __CABINET_PORTS__));
      return false;
    },
  });

  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      <a className="u-skip-link" href="#content">
        Перейти к содержимому
      </a>
      <TestContextBanner
        port={testContextPort}
        contextId={testContextId}
        subjectName={me?.displayName ?? null}
      />
      <OfflineBanner />
      <NovaTopBar
        title="Пятый элемент"
        subtitle="Кабинет инвестора"
        icon="chart"
        actions={
          me ? (
            <>
              <ProfileLink
                name={me.displayName}
                avatar={me.avatarUrl ? { urls: { sm: me.avatarUrl } } : null}
                href={PROFILE_HREF}
              />
              <Button
                variant="secondary"
                onClick={async () => {
                  await api.auth.logout().catch(() => undefined);
                  setCsrf(null);
                  setMe(null);
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
      <main id="content" data-investor-shell>
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && failure ? (
            <SessionCheckFailed failure={failure} onRetry={retry} busy={checking} />
          ) : null}
          {!checking && me && onProfilePage() ? (
            <ProfilePage
              port={profilePort}
              onProfileChanged={(next) =>
                setMe((prev) =>
                  prev
                    ? {
                        ...prev,
                        displayName: next.displayName,
                        avatarUrl: next.avatar?.urls.sm ?? null,
                      }
                    : prev,
                )
              }
              onPasswordChanged={() => {
                // Сессии закрыты все, включая эту — общий порядок, как у основателя.
                setCsrf(null);
                goToLogin(__CABINET_PORTS__);
              }}
            />
          ) : null}
          {!checking && me && !onProfilePage() ? (
            <EmptyState
              title="Кабинет в разработке"
              description="Возможности для инвесторов сейчас прорабатываются заново. Когда они появятся, они будут здесь."
            />
          ) : null}
        </Container>
      </main>
    </>
  );
}
