import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Container,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  OfflineBanner,
  Stack,
  UI_KEYFRAMES,
} from '@unicorn/ui';
import type { CurrentUser, ProjectFull } from '@unicorn/contracts';
import { ApiError, api, setCsrf } from './api';
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
            <ProjectsPage onOpen={(id) => setOpenProject(id)} />
          ) : null}
          {!checking && me && openProject !== null ? (
            <ProjectPage projectId={openProject} onBack={() => setOpenProject(null)} />
          ) : null}
        </Container>
      </main>
    </>
  );
}

function Header({ me, onLogout }: { me: CurrentUser | null; onLogout: () => void }) {
  return (
    <header style={{ borderBottom: '1px solid var(--u-border)', background: 'var(--u-surface)' }}>
      <Container
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          minHeight: 64,
          gap: 'var(--u-space-4)',
        }}
      >
        <strong>Кабинет основателя</strong>
        {me ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--u-space-4)' }}>
            <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              {me.displayName}
            </span>
            <Button variant="secondary" onClick={onLogout}>
              Выйти
            </Button>
          </div>
        ) : null}
      </Container>
    </header>
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
