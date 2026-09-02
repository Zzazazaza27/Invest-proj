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
  NotificationPreference,
  SupportTicketStatus,
} from '@unicorn/contracts';
import {
  BugReportWidget,
  NotificationsCard,
  SupportCard,
  decideAccess,
  hrefFor,
} from '@unicorn/cabinet';
import { ApiError, api, setCsrf } from './api';
import { AssignmentsPage } from './pages/AssignmentsPage';

/**
 * Кабинет эксперта.
 *
 * Весь кабинет построен вокруг одного правила: рецензия принадлежит эксперту.
 * Он видит только свои назначения, отвечает на них сам и подаёт ровно одну
 * рецензию по каждому — остальное запрещено на сервере, а не спрятано здесь.
 *
 * Конфликт интересов заявляется до работы, а не после: заявленный и
 * неразрешённый конфликт физически блокирует назначение (триггер в БД).
 */
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

  const load = useCallback(async () => {
    try {
      const profile = await api.auth.me();
      // Кабинет открывается только своей роли: до этого войти здесь мог кто
      // угодно и остаться в чужом разделе, где сервер отвечает отказом.
      const decision = decideAccess(profile.roles, 'expert');
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
        subtitle="Кабинет эксперта"
        icon="check"
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

      <main id="content">
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && me ? (
            <Stack gap="var(--u-space-6)">
              <AssignmentsPage />
              {/*
                Уведомления эксперту важнее, чем кому-либо: назначение приходит
                со сроком, и пропущенное письмо означает просроченную рецензию.
              */}
              <NotificationsCard port={notificationsPort} />
              <SupportCard port={supportPort} />
            </Stack>
          ) : null}
        </Container>
      </main>
      {/*
        Форма сообщения об ошибке доступна везде, а не на отдельной странице:
        о проблеме сообщают там, где её увидели.
      */}
      {me ? <BugReportWidget port={bugReportPort} appVersion={__APP_VERSION__} /> : null}
    </>
  );
}
