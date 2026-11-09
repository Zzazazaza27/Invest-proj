import { useEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Container,
  Field,
  IconTile,
  Input,
  Select,
  Stack,
} from '@fifth/ui';
import { uuidv7, type ServiceCountry } from '@fifth/contracts';
import {
  GroupNotice,
  SessionCheckFailed,
  classifySessionFailure,
  noteGroupError,
  takeReturn,
  useMailAvailability,
  type SessionFailure,
} from '@fifth/cabinet';
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
 * контрактах). Служебные роли назначает платформа.
 */
const SELF_SERVICE_ROLES = [
  {
    value: 'founder' as const,
    title: 'Основатель',
    description: 'Веду проект и рассказываю о нём',
  },
  {
    value: 'investor' as const,
    title: 'Инвестор',
    description: 'Смотрю проекты',
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
 * Служебные и демонстрационные учётки заводятся как `имя@fifth.local`, и вводить
 * домен руками каждый раз незачем — кабинеты дополняют короткое имя сами
 * (`apps/lab/src/App.tsx`). Экран входа обязан вести себя так же: иначе
 * `demo-admin` уходит на сервер как есть, отвергается проверкой адреса, и
 * человек видит «проверьте заполнение полей» на верно введённом логине.
 *
 * На обычные адреса это не влияет: в них уже есть `@`.
 */
const INTERNAL_DOMAIN = 'fifth.local';

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
 * Почта на платформе не подключена (`MAIL_TRANSPORT=none`): маршруты
 * восстановления отвечают `feature_disabled`. Сервер отказывает ДО поиска
 * адреса, поэтому ответ одинаков для любого адреса и перебора учёток не
 * открывает. Человеку — прямо, что канала нет: «Сервер недоступен» заставлял
 * бы повторять попытку впустую.
 */
const MAIL_DISABLED_TEXT =
  'Восстановление пароля пока недоступно: отправка писем на платформе не подключена.';

function isMailDisabled(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'feature_disabled';
}

/**
 * Сервер отверг саму ссылку: просрочена, использована, чужого назначения или не
 * существует — ответ один (422 с полем `token`). Только это — «ссылка устарела»; сбой
 * сети, 429 и 5xx — временная ошибка с повтором (Тэнк, 09.11).
 */
function isLinkRejected(err: unknown): boolean {
  if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 422)) return false;
  const fields = (err.problem as { errors?: unknown } | null)?.errors;
  return Array.isArray(fields) && fields.some((f) => (f as { path?: unknown })?.path === 'token');
}

const TEMPORARY_FAILURE_TEXT = 'Не удалось связаться с сервером. Попробуйте ещё раз.';

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
  id?: string;
  displayName?: string;
  roles?: string[];
}

export default function App() {
  const initial = tokenFromHash();
  const [mode, setMode] = useState<Mode>(initial?.mode ?? modeFromHash() ?? 'login');
  const [linkToken, setLinkToken] = useState<string>(initial?.token ?? '');
  const [notice, setNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  /**
   * Проверку сессии выполнить не удалось.
   *
   * Отдельно от «сессии нет»: при 429 или обрыве связи про сессию ничего не
   * известно, и показывать вошедшему человеку форму входа — значит предлагать
   * ему ввести пароль в тот же исчерпанный лимит.
   */
  const [probeFailure, setProbeFailure] = useState<Extract<
    SessionFailure,
    { kind: 'unavailable' }
  > | null>(null);
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
   * Действует ли ссылка из письма (смена пароля, подтверждение почты). Проверяется при
   * открытии, токен при этом не расходуется (M170): просить новый пароль по устаревшей
   * ссылке и отказывать после ввода — неудобно (Томас, 08.11). `unknown` — проверить не
   * удалось (сеть, сервер): это не «устарела», человеку — повтор.
   */
  const [link, setLink] = useState<'checking' | 'alive' | 'dead' | 'unknown' | 'disabled'>(
    'checking',
  );
  /** Повтор проверки ссылки по нажатию: меняется — проверка идёт заново. */
  const [linkAttempt, setLinkAttempt] = useState(0);
  /**
   * Страна обслуживания (этап 5.6.5, обеим ролям — владелец 2026-09-18): список
   * активных стран — публичный; язык от страны не зависит;
   * одна страна предлагается для подтверждения, несколько — выбор. Пустой
   * список — регистрация без страны.
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
   * Ключ повтора «Забыли пароль» (4.11, M162): один на адрес, пока ответ не получен. Повтор
   * после обрыва связи идёт с тем же ключом — второго письма сервер не отправит.
   */
  const forgotKey = useRef<{ email: string; key: string } | null>(null);
  /** Группа «Почта»: при закрытой отправке форма предупреждает и не отправляет. */
  const mail = useMailAvailability(mode === 'forgot' ? api.features : undefined);

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
      // Подтверждение почты — по нажатию, не при открытии (Тэнк, Томас 09.11).
      setMode(found.mode);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
    // Пустой список зависимостей намеренно: обработчик читает адрес и зовёт
    // сеттеры состояния, которые React гарантирует стабильными. Подписка
    // ставится один раз на жизнь экрана.
  }, []);

  useEffect(() => {
    if ((mode !== 'reset' && mode !== 'verify') || !linkToken) return;
    let cancelled = false;
    setLink('checking');
    api.auth.linkCheck(mode === 'reset' ? 'password_reset' : 'email_verify', linkToken).then(
      () => !cancelled && setLink('alive'),
      (err: unknown) => {
        if (cancelled) return;
        // Отказ ссылки — 400/422. Сбой сети или сервера не повод объявлять ссылку мёртвой.
        // Почта выключена — смена пароля невозможна вовсе; это не сбой связи.
        setLink(isLinkRejected(err) ? 'dead' : isMailDisabled(err) ? 'disabled' : 'unknown');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [mode, linkToken, linkAttempt]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Переход по ссылке из письма обрабатывается ДО проверки сессии: у
      // человека, меняющего пароль, сессии обычно нет, а если есть — она всё
      // равно перестанет действовать после смены. Отправить его в кабинет,
      // не дав закончить начатое, значило бы потерять ссылку.
      if (initial) {
        setChecking(false);
        return;
      }
      try {
        const me = (await api.auth.me()) as SessionUser;
        if (cancelled) return;
        setProbeFailure(null);
        applySession(me);
      } catch (error) {
        if (cancelled) return;
        const verdict = classifySessionFailure(error);
        // Форма входа — только по подтверждённому 401.
        if (verdict.kind === 'absent') setUser(null);
        else setProbeFailure(verdict);
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
    // Возврат на страницу, с которой ушли на вход (2.2/2.3): только тот же пользователь и
    // только кабинет его ролей. Права на самой странице проверит сервер.
    const back = me.id
      ? takeReturn(
          me.id,
          available.map((c) => c.path),
        )
      : null;
    if (back) {
      window.location.assign(back);
      return;
    }
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
      if (err.status === 429) {
        // Срок берётся из ответа сервера (`Retry-After`), а не называется
        // наугад: «через минуту» при ведре на 60 секунд ещё случайно совпадало,
        // но человек всё равно повторял раньше времени и получал тот же отказ.
        const wait = err.retryAfterSeconds;
        return wait && wait > 0
          ? `Слишком много попыток. Повторите через ${wait} с — введённое сохранится`
          : 'Слишком много попыток. Повторите чуть позже — введённое сохранится';
      }
      if (err.status === 409) return 'Такая учётная запись уже существует';
      if (err.status === 422 || err.status === 400) {
        return err.problem?.detail ?? 'Проверьте заполнение полей';
      }
      // Выключенная функция — не сбой: сервер отвечает, повтор ничего не даст.
      // «Сервер недоступен» здесь заставлял бы человека пробовать снова.
      if (err.code === 'feature_disabled') return 'Эта функция пока недоступна';
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
              ...(serviceCountry ? { serviceCountry } : {}),
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
   * Подтверждение адреса — по нажатию человека, не при открытии страницы.
   *
   * Почтовые сервисы открывают ссылки из писем для проверки и могли израсходовать её
   * раньше человека (Тэнк, Томас 09.11). Сессия не нужна: письмо открывают в том
   * браузере, где оно пришло, и это почти никогда не тот, где открыт кабинет.
   */
  async function confirmEmailLink(): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await api.auth.confirmEmail(linkToken);
      setNotice('Адрес подтверждён. Теперь можно войти.');
      setMode('login');
      forgetHash();
    } catch (err) {
      // Израсходована или устарела — общий экран. Сбой сети — повтор на месте: если
      // подтверждение всё же прошло, повтор приведёт на тот же общий экран.
      if (isLinkRejected(err)) setLink('dead');
      else
        setError(
          err instanceof ApiError && err.status === 429 ? describe(err) : TEMPORARY_FAILURE_TEXT,
        );
    } finally {
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
    const address = toAddress(email);
    if (forgotKey.current?.email !== address) forgotKey.current = { email: address, key: uuidv7() };
    try {
      await api.auth.passwordForgot(address, { idempotencyKey: forgotKey.current.key });
      forgotKey.current = null;
      setNotice(
        'Если такой адрес зарегистрирован, письмо со ссылкой отправлено. ' +
          'Ссылка действует ограниченное время и срабатывает один раз.',
      );
      setMode('login');
    } catch (err) {
      // Почта на платформе не подключена (MAIL_TRANSPORT=none): сервер
      // отказывает ДО поиска адреса, поэтому ответ одинаков для любого адреса
      // и перебора учёток не открывает. Человеку — прямо, что канала нет.
      noteGroupError(err);
      setError(
        isMailDisabled(err)
          ? MAIL_DISABLED_TEXT
          : err instanceof ApiError && err.code === 'group_unavailable'
            ? 'Отправка писем сейчас недоступна. Попробуйте позже.'
            : err instanceof ApiError && err.outcomeUnknown
              ? 'Ответ не получен. Нажмите «Прислать ссылку» ещё раз — второго письма это не отправит.'
              : describe(err),
      );
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
      // Без почты сервер отказывает и здесь — тем же текстом, что при запросе. Отвергнутая
      // ссылка — общий экран «устарела», как при открытии.
      if (isLinkRejected(err)) setLink('dead');
      else setError(isMailDisabled(err) ? MAIL_DISABLED_TEXT : describe(err));
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

  // Один кабинет — переход уже запущен (applySession). Экран выбора здесь
  // мелькнул бы на время загрузки кабинета: показывать нечего выбирать.
  if (user && cabinets.length === 1) {
    return (
      <Container>
        <p className="auth-status">Открываем кабинет…</p>
      </Container>
    );
  }

  if (checking) {
    return (
      <Container>
        <p className="auth-status">Проверяем сессию…</p>
      </Container>
    );
  }

  // Повтор по нажатию, без автоматического цикла: 429 лечится паузой, а
  // клиент, повторяющий запрос сам, эту паузу и съедает.
  if (probeFailure) {
    return (
      <Container>
        <div className="auth-shell">
          <SessionCheckFailed
            failure={probeFailure}
            onRetry={() => {
              setChecking(true);
              void api.auth
                .me()
                .then((me) => {
                  setProbeFailure(null);
                  applySession(me as SessionUser);
                })
                .catch((error: unknown) => {
                  const verdict = classifySessionFailure(error);
                  if (verdict.kind === 'absent') {
                    setUser(null);
                    setProbeFailure(null);
                  } else setProbeFailure(verdict);
                })
                .finally(() => setChecking(false));
            }}
            busy={checking}
          />
        </div>
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
                Учётная запись создана, но ни один кабинет ей пока не доступен. Служебные роли
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

  // Ссылка из письма — общий экран для любого назначения, пока она не проверена или не
  // действует: «проверяем», «устарела или уже использована» со способом получить новую,
  // «проверить не удалось» с повтором. Действующая ссылка — экран своего действия ниже.
  if ((mode === 'reset' || mode === 'verify') && link !== 'alive') {
    const purpose = mode === 'reset' ? 'password_reset' : 'email_verify';
    const backToLogin = (
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
    );
    return (
      <Container>
        <div className="auth-shell">
          <Card>
            <Stack>
              {link === 'checking' ? (
                <p className="auth-subtitle" data-link="checking" data-link-purpose={purpose}>
                  Проверяем ссылку…
                </p>
              ) : link === 'disabled' ? (
                <>
                  <p className="auth-subtitle" data-link="disabled" data-link-purpose={purpose}>
                    {MAIL_DISABLED_TEXT}
                  </p>
                  {backToLogin}
                </>
              ) : link === 'unknown' ? (
                <>
                  <div data-link="unknown" data-link-purpose={purpose}>
                    <h1 className="auth-title">Не удалось проверить ссылку</h1>
                    <p className="auth-subtitle">
                      Нет связи с сервером. Ссылка, возможно, ещё действует — попробуйте ещё раз.
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="brand"
                    onClick={() => setLinkAttempt((n) => n + 1)}
                  >
                    Проверить ещё раз
                  </Button>
                  {backToLogin}
                </>
              ) : (
                <>
                  <div data-link="dead" data-link-purpose={purpose}>
                    <h1 className="auth-title">Ссылка устарела или уже использована</h1>
                    <p className="auth-subtitle">
                      {purpose === 'password_reset'
                        ? 'Ссылка из письма действует недолго и срабатывает один раз. Запросите новое письмо — пароль пока не менялся.'
                        : 'Ссылка из письма действует сутки и срабатывает один раз. Если адрес уже подтверждён, делать ничего не нужно. Иначе войдите — в профиле кабинета можно прислать письмо ещё раз.'}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="brand"
                    onClick={() => {
                      setMode(purpose === 'password_reset' ? 'forgot' : 'login');
                      setError(null);
                      forgetHash();
                    }}
                  >
                    {purpose === 'password_reset' ? 'Запросить новую ссылку' : 'Войти'}
                  </Button>
                  {purpose === 'password_reset' ? backToLogin : null}
                </>
              )}
            </Stack>
          </Card>
        </div>
      </Container>
    );
  }

  // Действующая ссылка подтверждения: само открытие ничего не меняет, адрес
  // подтверждается нажатием (Тэнк, Томас 09.11).
  if (mode === 'verify') {
    return (
      <Container>
        <div className="auth-shell">
          <Card>
            <Stack>
              <div data-link="alive" data-link-purpose="email_verify">
                <h1 className="auth-title">Подтверждение почты</h1>
                <p className="auth-subtitle">
                  Нажмите кнопку, чтобы подтвердить адрес почты вашего аккаунта.
                </p>
              </div>
              {error ? (
                <p className="auth-error" role="alert">
                  {error}
                </p>
              ) : null}
              <Button
                type="button"
                variant="brand"
                loading={busy}
                disabled={busy}
                data-testid="confirm-email"
                onClick={() => void confirmEmailLink()}
              >
                Подтвердить почту
              </Button>
            </Stack>
          </Card>
        </div>
      </Container>
    );
  }

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

                <GroupNotice group="mail" availability={mail} />

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
                  disabled={busy || email.trim().length === 0 || !mail.canWrite}
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
                    : 'Роль можно выбрать из двух: основатель или инвестор.'}
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

              {mode === 'register' && countries && countries.length > 0 ? (
                <div data-service-country={serviceCountry || 'none'}>
                  {countries.length === 1 ? (
                    <Checkbox
                      className="auth-consent"
                      id="serviceCountry"
                      checked={countryConfirmed}
                      onChange={(e) => {
                        setCountryConfirmed(e.target.checked);
                        setServiceCountry(e.target.checked ? countries[0]!.code : '');
                      }}
                      label={
                        <>
                          Страна обслуживания — {countries[0]!.code.toUpperCase()}. Подтверждаю: от
                          неё зависят валюта и условия привлечения; сменить её позже нельзя.
                        </>
                      }
                    />
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
                <Checkbox
                  className="auth-consent"
                  checked={consentGiven}
                  onChange={(e) => setConsentGiven(e.target.checked)}
                  label="Принимаю правила платформы, оферту, согласие на обработку персональных данных и условия вознаграждения оператора"
                />
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
