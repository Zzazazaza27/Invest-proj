import { useEffect, useState } from 'react';
import { Badge, Button, Card, Container, Field, Input, Stack } from '@unicorn/ui';
import { ApiError, api, setCsrf } from './api';
import { cabinetUrl, cabinetsForRoles, type Cabinet } from './routing';
import './auth.css';

/**
 * Вход и регистрация — одно место для всех ролей.
 *
 * Раньше форма входа была скопирована в каждый кабинет: четыре копии одного
 * экрана, которые расходились по одной за раз (в Ф44 в трёх из них нашли уже
 * исправленную в четвёртой ошибку сброса CSRF-токена). Регистрации не было
 * нигде, кроме прямых вызовов API.
 *
 * Здесь же решается, куда человек попадёт дальше: роль он не выбирает — её
 * возвращает сервер в `/v1/auth/me`.
 */

/**
 * Самостоятельно выдаются ровно две роли (`SelfServiceRoleSchema` в
 * контрактах). Эксперта назначает платформа: рецензент, выдавший себе роль
 * сам, обессмысливает экспертизу — поэтому в списке его нет и быть не должно.
 */
const SELF_SERVICE_ROLES = [
  {
    value: 'founder' as const,
    title: 'Основатель',
    description: 'Подаю проект, ищу инвестиции и сопровождение',
  },
  {
    value: 'investor' as const,
    title: 'Инвестор',
    description: 'Смотрю проекты, участвую в сделках',
  },
];

/**
 * Четыре документа, без акцепта которых аккаунт не активируется. Это серверный
 * инвариант, продублированный триггером в БД, — здесь их согласие собирается
 * одной галочкой, но уходит на сервер четырьмя акцептами.
 */
const REQUIRED_CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'] as const;
const LOCALE = 'ru-RU' as const;

/**
 * Внутренний домен служебных учётных записей.
 *
 * Учётки стенда и организаторов заводятся как `имя@unicorn.local`, и вводить
 * домен руками каждый раз незачем — кабинеты дополняют короткое имя сами
 * (`apps/lab/src/App.tsx`). Экран входа обязан вести себя так же: иначе
 * `stand-founder` уходит на сервер как есть, отвергается проверкой адреса, и
 * человек видит «проверьте заполнение полей» на верно введённом логине.
 *
 * На обычные адреса это не влияет: в них уже есть `@`.
 */
const INTERNAL_DOMAIN = 'unicorn.local';

function toAddress(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes('@') ? trimmed : `${trimmed}@${INTERNAL_DOMAIN}`;
}

interface ConsentTemplate {
  kind: string;
  version: string;
  locale: string;
}

type Mode = 'login' | 'register';

interface SessionUser {
  displayName?: string;
  roles?: string[];
}

export default function App() {
  const [mode, setMode] = useState<Mode>('login');
  const [checking, setChecking] = useState(true);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [cabinets, setCabinets] = useState<Cabinet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'founder' | 'investor'>('founder');
  const [consentGiven, setConsentGiven] = useState(false);

  /**
   * Уже вошедшего человека не заставляем входить снова.
   *
   * 401 здесь — законный ответ «никто», а не сбой: страница входа обязана
   * открываться у неаутентифицированного пользователя.
   */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = (await api.auth.me()) as SessionUser;
        if (cancelled) return;
        applySession(me);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function applySession(me: SessionUser): void {
    setUser(me);
    const available = cabinetsForRoles(me.roles ?? []);
    setCabinets(available);
    // Один кабинет — выбирать не из чего: отправляем сразу. Экран «выберите
    // кабинет» с единственной кнопкой это лишний шаг, а не забота.
    if (available.length === 1) {
      window.location.assign(cabinetUrl(available[0]!));
    }
  }

  /**
   * Человекочитаемая причина отказа.
   *
   * Дословный текст сервера при 401 не показывается: он различает «нет такого
   * аккаунта» и «неверный пароль», а это перебор учётных записей (Ф44).
   */
  function describe(err: unknown): string {
    if (err instanceof ApiError) {
      if (err.status === 401) return 'Неверная почта или пароль';
      if (err.status === 429) return 'Слишком много попыток. Повторите через минуту';
      if (err.status === 409) return 'Такая учётная запись уже существует';
      if (err.status === 422 || err.status === 400) {
        return err.problem?.detail ?? 'Проверьте заполнение полей';
      }
      return 'Сервер недоступен. Попробуйте позже';
    }
    // Собственные сообщения приложения (например, «документ не опубликован»)
    // показываются как есть: они объясняют причину точнее общей фразы.
    if (err instanceof Error && err.message) return err.message;
    return 'Не удалось выполнить запрос';
  }

  /**
   * Акцепты обязательных документов в действующих версиях.
   *
   * Если сервер не отдал какой-то из четырёх документов, регистрацию не
   * отправляем вовсе: подставить версию самим означало бы получить отказ на
   * стороне сервера и показать его как сбой платформы.
   */
  async function requiredConsents(): Promise<
    { kind: (typeof REQUIRED_CONSENTS)[number]; version: string; locale: typeof LOCALE }[]
  > {
    const response = (await api.http.request({
      path: `/auth/consents/templates?locale=${encodeURIComponent(LOCALE)}`,
    })) as { items?: ConsentTemplate[] };

    const byKind = new Map((response.items ?? []).map((item) => [item.kind, item]));
    // Локаль берётся своя, а не из ответа: запрашивали конкретную, и подстановка
    // чужой означала бы акцепт документа на языке, которого человек не видел.
    return REQUIRED_CONSENTS.map((kind) => {
      const template = byKind.get(kind);
      if (!template) {
        throw new Error(`Документ «${kind}» не опубликован — регистрация недоступна`);
      }
      return { kind, version: template.version, locale: LOCALE };
    });
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      // Версии документов НЕ зашиты в приложении: сервер отвергает акцепт с
      // недействующей версией, а угаданное значение давало отказ, который
      // выглядел как поломка сервера. Актуальные версии спрашиваются перед
      // самой отправкой — между открытием формы и нажатием кнопки условия
      // могли обновиться.
      const session =
        mode === 'login'
          ? await api.auth.login({ email: toAddress(email), password })
          : await api.auth.register({
              email: toAddress(email),
              password,
              displayName,
              role,
              locale: LOCALE,
              consents: await requiredConsents(),
            });

      // Свежий CSRF-токен приходит в теле: cookie может отстать, и следующий
      // небезопасный запрос ушёл бы с прежним токеном (Ф44).
      const csrf = (session as { csrfToken?: string }).csrfToken;
      if (csrf) setCsrf(csrf);

      const me = (await api.auth.me()) as SessionUser;
      applySession(me);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      // null — это сброс токена, а не «перечитай cookie»: иначе клиент
      // остался бы с токеном уже закрытой сессии.
      setCsrf(null);
      setUser(null);
      setCabinets([]);
    }
  }

  if (checking) {
    return (
      <Container>
        <p className="auth-status">Проверяем сессию…</p>
      </Container>
    );
  }

  // Вошёл и ролей несколько — человек выбирает, куда идти.
  if (user && cabinets.length > 0) {
    return (
      <Container>
        <div className="auth-shell">
          <Card>
            <Stack>
              <div>
                <Badge tone="success">вход выполнен</Badge>
                <h1 className="auth-title">{user.displayName ?? 'Вы вошли'}</h1>
                <p className="auth-subtitle">Выберите, куда перейти</p>
              </div>
              <ul className="auth-cabinets">
                {cabinets.map((cabinet) => (
                  <li key={cabinet.key}>
                    <a className="auth-cabinet" href={cabinetUrl(cabinet)}>
                      <span className="auth-cabinet-title">{cabinet.title}</span>
                      <span className="auth-cabinet-desc">{cabinet.description}</span>
                    </a>
                  </li>
                ))}
              </ul>
              <Button variant="secondary" onClick={() => void logout()}>
                Выйти
              </Button>
            </Stack>
          </Card>
        </div>
      </Container>
    );
  }

  // Вошёл, но ни одной роли с кабинетом: аккаунт создан, доступ ещё не выдан.
  if (user) {
    return (
      <Container>
        <div className="auth-shell">
          <Card>
            <Stack>
              <h1 className="auth-title">Доступ ещё не открыт</h1>
              <p className="auth-subtitle">
                Учётная запись создана, но ни один кабинет ей пока не доступен. Роль эксперта
                назначает платформа — дождитесь приглашения.
              </p>
              <Button variant="secondary" onClick={() => void logout()}>
                Выйти
              </Button>
            </Stack>
          </Card>
        </div>
      </Container>
    );
  }

  return (
    <Container>
      <div className="auth-shell">
        <Card>
          <form onSubmit={(e) => void submit(e)} noValidate>
            <Stack>
              <div>
                <h1 className="auth-title">{mode === 'login' ? 'Вход' : 'Регистрация'}</h1>
                <p className="auth-subtitle">
                  {mode === 'login'
                    ? 'Кабинет откроется по вашей роли — выбирать его не нужно.'
                    : 'Роль можно выбрать из двух: эксперта назначает платформа.'}
                </p>
              </div>

              {mode === 'register' ? (
                <fieldset className="auth-roles">
                  <legend className="auth-legend">Кто вы</legend>
                  {SELF_SERVICE_ROLES.map((item) => (
                    <label
                      key={item.value}
                      className={`auth-role${role === item.value ? ' auth-role--active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="role"
                        value={item.value}
                        checked={role === item.value}
                        onChange={() => setRole(item.value)}
                      />
                      <span>
                        <span className="auth-role-title">{item.title}</span>
                        <span className="auth-role-desc">{item.description}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
              ) : null}

              {mode === 'register' ? (
                <Field label="Как к вам обращаться" htmlFor="displayName">
                  <Input
                    id="displayName"
                    value={displayName}
                    autoComplete="name"
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </Field>
              ) : null}

              <Field
                label="Почта"
                htmlFor="email"
                hint={
                  mode === 'login'
                    ? 'Для служебных учётных записей достаточно короткого имени — домен подставится сам.'
                    : undefined
                }
              >
                {/*
                  Не type="email": служебные учётные записи стенда заводятся во
                  внутреннем домене, и браузер отвергал бы их до отправки формы.
                */}
                <Input
                  id="email"
                  value={email}
                  autoComplete="username"
                  onChange={(e) => setEmail(e.target.value)}
                />
              </Field>

              <Field
                label="Пароль"
                htmlFor="password"
                hint={mode === 'register' ? 'Не короче 12 символов' : undefined}
              >
                <Input
                  id="password"
                  type="password"
                  value={password}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>

              {mode === 'register' ? (
                <label className="auth-consent">
                  <input
                    type="checkbox"
                    checked={consentGiven}
                    onChange={(e) => setConsentGiven(e.target.checked)}
                  />
                  <span>
                    Принимаю правила платформы, оферту, согласие на обработку персональных данных и
                    условия вознаграждения оператора
                  </span>
                </label>
              ) : null}

              {error ? (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                loading={busy}
                disabled={busy || (mode === 'register' && !consentGiven)}
              >
                {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
              </Button>

              <p className="auth-switch">
                {mode === 'login' ? 'Ещё нет аккаунта? ' : 'Уже зарегистрированы? '}
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => {
                    setMode(mode === 'login' ? 'register' : 'login');
                    setError(null);
                  }}
                >
                  {mode === 'login' ? 'Зарегистрироваться' : 'Войти'}
                </button>
              </p>

              <p className="auth-back">
                <a href="/">← На главную</a>
              </p>
            </Stack>
          </form>
        </Card>
      </div>
    </Container>
  );
}
