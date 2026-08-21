import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  IconTile,
  Input,
  LoadingState,
  NovaTopBar,
  OfflineBanner,
  Stack,
  TrustStrip,
  UI_KEYFRAMES,
} from '@unicorn/ui';
import type { CurrentUser, ProjectFull } from '@unicorn/contracts';
import { ApiError, api, setCsrf } from './api';
import { BusinessEntitiesCard, NotificationsCard } from '@unicorn/cabinet';
import type {
  AddEntityMemberRequest,
  CreateEntityRequest,
  NotificationPreference,
} from '@unicorn/contracts';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectPage } from './pages/ProjectPage';

/**
 * Кабинет основателя.
 *
 * Что показать, решает сервер: фронтенд лишь отражает его ответы. Спрятанная
 * кнопка не является защитой — любая операция всё равно проверяется ролью и
 * политикой БД на бэкенде, поэтому здесь нет ни одной проверки прав «на
 * всякий случай».
 */
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
  savePreferences: (items: NotificationPreference[]) =>
    api.notifications.updatePreferences(items),
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
  const [openProject, setOpenProject] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMe(await api.auth.me());
    } catch (error) {
      // 401 здесь — норма: пользователь просто не вошёл.
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
      <Header
        me={me}
        onLogout={async () => {
          await api.auth.logout().catch(() => undefined);
          setCsrf(null);
          setMe(null);
          setOpenProject(null);
        }}
      />
      <main id="content">
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && !me ? <LoginPage onLoggedIn={() => void load()} /> : null}
          {!checking && me && openProject === null ? (
            <Stack gap="var(--u-space-6)">
              <ProjectsPage onOpen={(id) => setOpenProject(id)} />
              {/*
                Юрлицо основателю нужно раньше, чем предложение: без
                проверенной компании выпуск закрыт. Поэтому карточка стоит в
                списке проектов, а не прячется внутри одного из них.
              */}
              <BusinessEntitiesCard port={entitiesPort} />
              <NotificationsCard port={notificationsPort} />
            </Stack>
          ) : null}
          {!checking && me && openProject !== null ? (
            <ProjectPage projectId={openProject} onBack={() => setOpenProject(null)} />
          ) : null}
          {me ? (
            <div
              style={{
                marginTop: 'var(--u-space-7)',
                paddingTop: 'var(--u-space-5)',
                borderTop: '1px solid var(--u-border)',
              }}
            >
              <TrustStrip items={TRUST_ITEMS} />
            </div>
          ) : null}
        </Container>
      </main>
    </>
  );
}

function Header({ me, onLogout }: { me: CurrentUser | null; onLogout: () => void }) {
  return (
    <NovaTopBar
      title="UNICORN LAUNCH"
      subtitle="Кабинет основателя"
      icon="rocket"
      actions={
        me ? (
          <>
            {/*
              Имя прячется на узком экране, кнопка выхода — нет: подпись это
              справка, а выход — действие, и терять его на телефоне нельзя.
            */}
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
            <Button variant="secondary" onClick={onLogout}>
              <Icon name="logout" size={16} />
              Выйти
            </Button>
          </>
        ) : null
      }
    />
  );
}

/**
 * Полоса под содержимым кабинета.
 *
 * Не украшение: три строки отвечают на вопросы, которые основатель задаёт
 * перед тем, как отдать платформе документы компании, — кто это увидит, что
 * происходит с деньгами и к кому идти, если что-то пойдёт не так.
 */
const TRUST_ITEMS = [
  {
    icon: 'shield' as const,
    title: 'Проверенные эксперты',
    description: 'Оценку дают эксперты с подтверждённой квалификацией',
  },
  {
    icon: 'lock' as const,
    title: 'Документы под шифрованием',
    description: 'Реквизиты и файлы компании доступны только вам и комплаенсу',
  },
  {
    icon: 'chat' as const,
    title: 'Ответ на обращение',
    description: 'Вопрос по заявке — через уведомления кабинета',
  },
];

function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card
      style={{
        maxWidth: 440,
        margin: 'var(--u-space-7) auto',
        padding: 'var(--u-space-6)',
        borderRadius: 'var(--u-radius-xl, var(--u-radius-lg))',
        boxShadow: 'var(--u-shadow-md)',
      }}
    >
      <div style={{ display: 'grid', justifyItems: 'center', gap: 'var(--u-space-2)' }}>
        <IconTile name="rocket" variant="solid" size={56} />
      </div>
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
            // Текст сервера, а не «что-то пошло не так»: он объясняет причину
            // (неверные данные, требуется повторный акцепт условий и т.д.).
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
          <div style={{ textAlign: 'center', display: 'grid', gap: 4 }}>
            <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)', fontWeight: 800 }}>
              Вход в кабинет
            </h1>
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              Заявки, материалы и статус проектов
            </span>
          </div>
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
          <Button type="submit" variant="brand" loading={busy}>
            Войти
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

/** Общие ярлыки статусов: они одинаковы во всех экранах кабинета. */
export const PROJECT_STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  submitted: 'Подан в сезон',
  ai_review: 'AI-анализ',
  expert_review: 'Экспертиза',
  bootcamp: 'Буткемп',
  finalist: 'Финалист',
  graduated: 'Выпускник',
  rejected: 'Отклонён',
  archived: 'В архиве',
};

export const LISTING_STATUS_LABEL: Record<string, string> = {
  not_listed: 'Не опубликован',
  listed: 'Опубликован',
  suspended_billing: 'Приостановлен по подписке',
  unlisted: 'Снят',
};

export function statusTone(status: string): 'neutral' | 'accent' | 'success' | 'warning' {
  if (status === 'graduated' || status === 'listed') return 'success';
  if (status === 'rejected' || status === 'suspended_billing') return 'warning';
  if (status === 'draft' || status === 'not_listed') return 'neutral';
  return 'accent';
}

/**
 * Значки статуса. Принимают ровно те два поля, которые показывают, — так один
 * компонент работает и с краткой формой из списка, и с полной карточкой.
 */
export function ProjectBadges({
  project,
}: {
  project: Pick<ProjectFull, 'status' | 'listingStatus'>;
}) {
  return (
    <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
      <Badge tone={statusTone(project.status)}>
        {PROJECT_STATUS_LABEL[project.status] ?? project.status}
      </Badge>
      <Badge tone={statusTone(project.listingStatus)}>
        {LISTING_STATUS_LABEL[project.listingStatus] ?? project.listingStatus}
      </Badge>
    </div>
  );
}

export { EmptyState, ErrorState };
