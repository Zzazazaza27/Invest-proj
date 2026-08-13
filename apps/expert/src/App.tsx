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
          }}
        >
          <strong>Кабинет эксперта</strong>
          {me ? (
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
          ) : null}
        </Container>
      </header>

      <main id="content">
        <Container style={{ padding: 'var(--u-space-6) var(--u-space-4)' }}>
          {checking ? <LoadingState label="Проверяем сессию" /> : null}
          {!checking && !me ? <LoginPage onLoggedIn={() => void load()} /> : null}
          {!checking && me ? <AssignmentsPage /> : null}
        </Container>
      </main>
    </>
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
