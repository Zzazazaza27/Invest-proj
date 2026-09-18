import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Container, Field, IconTile, Input, Select, Stack } from '@unicorn/ui';
import type { ServiceCountry } from '@unicorn/contracts';
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

/**
 * Экраны приложения входа.
 *
 * `reset` и `verify` открываются НЕ кнопкой, а переходом по ссылке из письма:
 * токен приходит во фрагменте адреса (`#reset=…`). Фрагмент выбран намеренно —
 * он не уходит на сервер и не попадает ни в логи прокси, ни в заголовок
 * Referer, в отличие от параметра запроса.
 */
type Mode = 'login' | 'register' | 'forgot' | 'reset' | 'verify';

/** Токен из фрагмента адреса. Возвращает и режим, который он открывает. */
function tokenFromHash(): { mode: Mode; token: string } | null {
  const match = /^#(reset|verify)=([A-Za-z0-9_-]{32,128})$/.exec(window.location.hash);
  if (!match) return null;
  return { mode: match[1] === 'reset' ? 'reset' : 'verify', token: match[2]! };
}

/**
 * Экран, названный фрагментом адреса: `#register` и `#login`.
 *
 * Витрина ведёт на это приложение двумя разными кнопками, и до Ф60 обе
 * открывали вход: кнопка «Регистрация» вводила в заблуждение — форма
 * регистрации существовала, но попасть на неё можно было только переключателем
 * внизу. Фрагмент выбран по той же причине, что и для токенов: он не уходит на
 * сервер, поэтому его добавление не меняет ни кэширование статики, ни маршрут
 * прокси — с точки зрения nginx это тот же `/login/`.
 *
 * Ничего, кроме двух известных значений, не принимается: режимы `reset` и
 * `verify` открываются только вместе с токеном, а `forgot` — осознанным
 * действием человека, а не ссылкой со стороны.
 */
function modeFromHash(): Mode | null {
  const hash = window.location.hash;
  if (hash === '#register') return 'register';
  if (hash === '#login') return 'login';
  return null;
}

/**
 * Держать фрагмент в согласии с открытым экраном.
 *
 * Иначе после переключения «Ещё нет аккаунта? → Зарегистрироваться» обновление
 * страницы вернуло бы человека на вход: в адресе остался бы прежний `#login`.
 * `replaceState` — чтобы переключатель не засорял историю браузера и «назад»
 * вело на витрину, а не на предыдущий режим той же формы.
 */
function rememberMode(mode: 'login' | 'register'): void {
  const next = `${window.location.pathname}${window.location.search}#${mode}`;
  window.history.replaceState(null, '', next);
}

/**
 * Убрать токен из адресной строки.
 *
 * Ссылка из письма остаётся в истории браузера и в заголовке окна; после того
 * как токен использован, держать его на виду незачем — а до использования
 * фрагмент всё равно уже прочитан приложением.
 */
function forgetHash(): void {
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

interface SessionUser {
  displayName?: string;
  roles?: string[];
}

export default function App() {
  const initial = tokenFromHash();
  const [mode, setMode] = useState<Mode>(initial?.mode ?? modeFromHash() ?? 'login');
  const [linkToken, setLinkToken] = useState<string>(initial?.token ?? '');
  const [notice, setNotice] = useState<string | null>(null);
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
  const [passwordRepeat, setPasswordRepeat] = useState('');
  /**
   * Страна обслуживания (этап 5.6.5): список активных стран — публичный;
   * одна страна предлагается для подтверждения, несколько — выбор. Пустой
   * список — регистрация без страны, её попросят перед открытием раунда.
   */
  const [countries, setCountries] = useState<ServiceCountry[] | null>(null);
  const [serviceCountry, setServiceCountry] = useState<string>('');
  const [countryConfirmed, setCountryConfirmed] = useState(false);

  useEffect(() => {
    if (mode !== 'register' || countries !== null) return;
    api.serviceCountries
      .list()
      .then((list) => {
        const active = list.items.filter((c) => c.isActive);
        // Одна страна предлагается для подтверждения, а не подставляется молча:
        // выбор становится значением только после флажка.
        setCountries(active);
      })
      .catch(() => setCountries([]));
  }, [mode, countries]);

  /**
   * Токены подтверждения, уже отправленные на сервер.
   *
   * Ссылка из письма одноразовая, а обработчиков у неё два: подписка на
   * `hashchange` и разбор адреса при открытии страницы. Когда срабатывали оба,
   * второй запрос получал законный отказ по использованному токену — и человек
   * видел «Адрес подтверждён» вместе с красной ошибкой валидации. Помним, что
   * уже отправляли: повторный вызов по тому же токену просто не нужен.
   */
  const confirmedTokens = useRef<Set<string>>(new Set());

  /**
   * Уже вошедшего человека не заставляем входить снова.
   *
   * 401 здесь — законный ответ «никто», а не сбой: страница входа обязана
   * открываться у неаутентифицированного пользователя.
   */
  /**
   * Ссылка из письма, открытая при уже загруженной странице.
   *
   * Смена только фрагмента адреса НЕ перезагружает документ: человек, у
   * которого вкладка со входом уже открыта, щёлкнул бы по ссылке из письма и
   * увидел прежний экран. Браузер об этом сообщает событием `hashchange` — на
   * него и подписываемся, иначе ссылка работает только в новой вкладке.
   */
  useEffect(() => {
    function onHashChange(): void {
      const found = tokenFromHash();
      if (!found) return;
      setLinkToken(found.token);
      setError(null);
      setNotice(null);
      if (found.mode === 'verify') void confirmEmailLink(found.token);
      else setMode('reset');
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
    // Пустой список зависимостей намеренно: обработчик читает адрес и зовёт
    // сеттеры состояния, которые React гарантирует стабильными. Подписка
    // ставится один раз на жизнь экрана.
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Переход по ссылке из письма обрабатывается ДО проверки сессии: у
      // человека, меняющего пароль, сессии обычно нет, а если есть — она всё
      // равно перестанет действовать после смены. Отправить его в кабинет,
      // не дав закончить начатое, значило бы потерять ссылку.
      if (initial) {
        setChecking(false);
        if (initial.mode === 'verify') await confirmEmailLink(initial.token);
        return;
      }
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
    // Типизированный метод клиента вместо сырого запроса: ответ разбирается
    // схемой, и опечатка в имени поля ловится здесь, а не отказом сервера на
    // акцепте с версией `undefined`.
    const templates = await api.auth.consentTemplates(LOCALE);

    const byKind = new Map(templates.map((item) => [item.kind, item]));
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
    // Сообщение о прошлом успехе гасим тоже: «Пароль изменён» рядом с
    // «Неверная почта или пароль» читается как противоречие, и человек не
    // понимает, к какой из его попыток относится каждая строка.
    setNotice(null);
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
              ...(role === 'founder' && serviceCountry ? { serviceCountry } : {}),
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

  /**
   * Переход по ссылке подтверждения адреса.
   *
   * Сессия не нужна: письмо открывают в том браузере, где оно пришло, и это
   * почти никогда не тот, где открыт кабинет.
   */
  async function confirmEmailLink(token: string): Promise<void> {
    if (confirmedTokens.current.has(token)) return;
    confirmedTokens.current.add(token);
    setBusy(true);
    try {
      await api.auth.confirmEmail(token);
      setNotice('Адрес подтверждён. Теперь можно войти.');
      setMode('login');
    } catch (err) {
      setError(describe(err));
      setMode('login');
    } finally {
      forgetHash();
      setBusy(false);
    }
  }

  /**
   * Запрос ссылки на смену пароля.
   *
   * Сообщение об успехе одинаково для существующего и несуществующего адреса —
   * потому что и ответ сервера одинаков. «Такого адреса нет» здесь было бы
   * перечислением пользователей, причём удобнее формы входа: пароль не нужен.
   */
  async function submitForgot(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.auth.passwordForgot(toAddress(email));
      setNotice(
        'Если такой адрес зарегистрирован, письмо со ссылкой отправлено. ' +
          'Ссылка действует ограниченное время и срабатывает один раз.',
      );
      setMode('login');
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  /** Смена пароля по ссылке. Сессия НЕ открывается — человек входит заново. */
  async function submitReset(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    // Совпадение паролей проверяется здесь, а не сервером: серверу второе поле
    // не нужно, а человеку нужно, чтобы опечатка не стоила ещё одного письма.
    if (password !== passwordRepeat) {
      setError('Пароли не совпадают');
      return;
    }
    setBusy(true);
    try {
      await api.auth.passwordReset(linkToken, password);
      setNotice('Пароль изменён. Войдите с новым паролем.');
      setPassword('');
      setPasswordRepeat('');
      setMode('login');
      forgetHash();
    } catch (err) {
      // Просроченная, использованная и поддельная ссылка отвечают одинаково —
      // и текст здесь тоже один. Разные формулировки подсказывали бы
      // подбирающему, что он близко, а человеку всё равно нужно одно и то же:
      // запросить письмо заново.
      setError(
        err instanceof ApiError && (err.status === 400 || err.status === 422)
          ? 'Ссылка недействительна или устарела. Запросите новую.'
          : describe(err),
      );
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

  // Ссылка из письма: смена пароля. Экран отдельный, потому что здесь нет
  // почты и нет входа — только новый пароль и подтверждение опечатки.
  if (mode === 'reset') {
    return (
      <Container>
        <div className="auth-shell">
          <Card>
            <form onSubmit={(e) => void submitReset(e)} noValidate>
              <Stack>
                <div>
                  <h1 className="auth-title">Новый пароль</h1>
                  <p className="auth-subtitle">
                    Ссылка срабатывает один раз. После смены пароля все открытые сессии закрываются
                    — на других устройствах придётся войти заново.
                  </p>
                </div>

                <Field label="Новый пароль" htmlFor="new-password" hint="Не короче 12 символов">
                  <Input
                    id="new-password"
                    type="password"
                    value={password}
                    autoComplete="new-password"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>

                <Field label="Повторите пароль" htmlFor="repeat-password">
                  <Input
                    id="repeat-password"
                    type="password"
                    value={passwordRepeat}
                    autoComplete="new-password"
                    onChange={(e) => setPasswordRepeat(e.target.value)}
                  />
                </Field>

                {error ? (
                  <p className="auth-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <Button
                  type="submit"
                  variant="brand"
                  loading={busy}
                  disabled={busy || password.length < 12}
                >
                  Сменить пароль
                </Button>

                <p className="auth-switch">
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => {
                      setMode('login');
                      setError(null);
                      forgetHash();
                    }}
                  >
                    Вернуться ко входу
                  </button>
                </p>
              </Stack>
            </form>
          </Card>
        </div>
      </Container>
    );
  }

  // Запрос ссылки. Отдельный экран, а не поле в форме входа: пароль здесь не
  // нужен вовсе, и общая форма заставляла бы браузер предлагать его сохранить.
  if (mode === 'forgot') {
    return (
      <Container>
        <div className="auth-shell">
          <Card>
            <form onSubmit={(e) => void submitForgot(e)} noValidate>
              <Stack>
                <div>
                  <h1 className="auth-title">Восстановление доступа</h1>
                  <p className="auth-subtitle">
                    Укажите адрес почты. Если он зарегистрирован, придёт письмо со ссылкой на смену
                    пароля.
                  </p>
                </div>

                <Field label="Почта" htmlFor="forgot-email">
                  <Input
                    id="forgot-email"
                    value={email}
                    autoComplete="username"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </Field>

                {error ? (
                  <p className="auth-error" role="alert">
                    {error}
                  </p>
                ) : null}

                <Button
                  type="submit"
                  variant="brand"
                  loading={busy}
                  disabled={busy || email.trim().length === 0}
                >
                  Прислать ссылку
                </Button>

                <p className="auth-switch">
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => {
                      setMode('login');
                      setError(null);
                    }}
                  >
                    Вернуться ко входу
                  </button>
                </p>
              </Stack>
            </form>
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
              <div className="auth-head">
                <IconTile name="rocket" variant="solid" size={56} />
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

              {mode === 'register' && role === 'founder' && countries && countries.length > 0 ? (
                <div data-service-country={serviceCountry || 'none'}>
                  {countries.length === 1 ? (
                    <label className="auth-consent">
                      <input
                        type="checkbox"
                        id="serviceCountry"
                        checked={countryConfirmed}
                        onChange={(e) => {
                          setCountryConfirmed(e.target.checked);
                          setServiceCountry(e.target.checked ? countries[0]!.code : '');
                        }}
                      />
                      <span>
                        Страна обслуживания — {countries[0]!.code.toUpperCase()}. Подтверждаю: от
                        неё зависят валюта и условия привлечения; сменить её позже нельзя.
                      </span>
                    </label>
                  ) : (
                    <Field
                      label="Страна обслуживания"
                      htmlFor="serviceCountry"
                      hint="От страны зависят валюта и условия привлечения. Выбор делается один раз; сменить её позже нельзя."
                    >
                      <Select
                        id="serviceCountry"
                        value={serviceCountry}
                        onChange={(e) => setServiceCountry(e.target.value)}
                      >
                        <option value="">— выбрать позже —</option>
                        {countries.map((c) => (
                          <option key={c.code} value={c.code}>
                            {c.code.toUpperCase()}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
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

              {notice ? (
                <p className="auth-notice" role="status">
                  {notice}
                </p>
              ) : null}

              {error ? (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              ) : null}

              <Button
                type="submit"
                variant="brand"
                loading={busy}
                disabled={busy || (mode === 'register' && !consentGiven)}
              >
                {mode === 'login' ? 'Войти' : 'Создать аккаунт'}
              </Button>

              {mode === 'login' ? (
                <p className="auth-switch">
                  <button
                    type="button"
                    className="auth-link"
                    onClick={() => {
                      setMode('forgot');
                      setError(null);
                      setNotice(null);
                    }}
                  >
                    Забыли пароль?
                  </button>
                </p>
              ) : null}

              <p className="auth-switch">
                {mode === 'login' ? 'Ещё нет аккаунта? ' : 'Уже зарегистрированы? '}
                <button
                  type="button"
                  className="auth-link"
                  onClick={() => {
                    const next = mode === 'login' ? 'register' : 'login';
                    setMode(next);
                    rememberMode(next);
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
