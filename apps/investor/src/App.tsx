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
  SessionCheckFailed,
  TestContextBanner,
  decideAccess,
  hrefFor,
  useSessionCheck,
} from '@fifth/cabinet';
import { api, setCsrf, testContextId, testContextPort } from './api';

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
          ) : null
        }
      />
      <main id="content" data-investor-shell>
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && failure ? (
            <SessionCheckFailed failure={failure} onRetry={retry} busy={checking} />
          ) : null}
          {!checking && me ? (
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
