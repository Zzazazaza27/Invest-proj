import { useCallback, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Button, Icon, NovaTopBar, UI_KEYFRAMES } from '@unicorn/ui';
import {
  ProfileLink,
  ProfilePage,
  SessionCheckFailed,
  useScrollToTopOnChange,
  useSessionCheck,
  type ProfilePort,
} from '@unicorn/cabinet';
import { api } from './api';
import { LoginPage } from './pages/LoginPage';
import { PlansPage } from './pages/PlansPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { FlagsPage } from './pages/FlagsPage';
import { CompliancePage } from './pages/CompliancePage';
import { SeasonPage } from './pages/SeasonPage';
import { AccessPage } from './pages/AccessPage';
import { FunnelPage } from './pages/FunnelPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { SupportPage } from './pages/SupportPage';
import { QuestionsPage } from './pages/QuestionsPage';
import { ApplicationSettingsPage } from './pages/ApplicationSettingsPage';
import { TextsPage } from './pages/TextsPage';
import { ServiceCountriesPage } from './pages/ServiceCountriesPage';
import { RoundPackagesPage } from './pages/RoundPackagesPage';
import { CommissionPage } from './pages/CommissionPage';
import { DealsPage } from './pages/DealsPage';
import { UsersPage } from './pages/UsersPage';
import { TestingSessionsPage } from './pages/TestingSessionsPage';
import { UiCatalogPage } from './pages/UiCatalogPage';
import { UserCardPage } from './pages/UserCardPage';
import {
  IntelligenceCardPage,
  IntelligencePage,
  IntelligenceSourceCardPage,
  IntelligenceSourcesPage,
} from './pages/IntelligencePage';

/**
 * Корень админки.
 *
 * Доступ определяется сервером: фронтенд лишь показывает или прячет экраны.
 * Любая операция всё равно проверяется ролью на бэкенде, поэтому «спрятанная»
 * кнопка не является защитой — и никакой логики допуска здесь нет.
 */

interface Me {
  id: string;
  displayName: string;
  roles: string[];
  /** Аватар для шапки; `null` — рисуется первая буква имени. */
  avatarUrl?: string | null;
}

/**
 * «Мой профиль»: имя, аватар и пароль. Экран общий со всеми кабинетами.
 */
const profilePort: ProfilePort = {
  load: () => api.myProfile(),
  updateName: (displayName) => api.updateMyName(displayName),
  uploadAvatar: (file) => api.uploadMyAvatar(file),
  removeAvatar: () => api.removeMyAvatar(),
  changePassword: async (input) => {
    await api.changeMyPassword(input);
  },
};

/**
 * Высота шапки — измеренная, а не записанная числом.
 *
 * От неё зависят две вещи: отметка, на которой останавливается боковое меню,
 * и высота рабочей области. Зашитые 64px были неправдой уже сейчас —
 * фактически шапка 69px, — и меню на пять пикселей заезжало под неё. А при
 * любой правке шапки (второй строкой подписи, другим размером аватара) число
 * разошлось бы снова и снова молча.
 *
 * Возвращается ref-ФУНКЦИЯ, а не объект: шапки нет в первом рендере (идёт
 * проверка сессии), и обычный эффект отработал бы по пустой ссылке ровно один
 * раз и больше не повторился — что и случилось при первой попытке. Функция
 * вызывается в момент появления узла и в момент его исчезновения.
 */
function useTopbarHeight(): (node: HTMLDivElement | null) => void {
  const observer = useRef<ResizeObserver | null>(null);

  return useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;

    const apply = () => {
      const height = Math.round(node.getBoundingClientRect().height);
      if (height > 0) {
        document.documentElement.style.setProperty('--admin-topbar-h', `${height}px`);
      }
    };
    apply();
    // Шапка меняет высоту при смене ширины окна: подпись переносится.
    observer.current = new ResizeObserver(apply);
    observer.current.observe(node);
  }, []);
}

export function App() {
  const navigate = useNavigate();
  const topbarRef = useTopbarHeight();
  // Смена раздела возвращает к началу страницы: иначе новый экран открывается
  // с той прокрутки, на которой человек бросил предыдущий.
  useScrollToTopOnChange(useLocation().pathname);
  const [me, setMe] = useState<Me | null>(null);
  /**
   * Сезоны отложены (M088): пункты сезона показываются только при включённом
   * `seasons.enabled`. Экраны и маршруты остаются — контур отключён, а не
   * удалён; администратор увидит их сразу, как флаг вернут.
   */
  const [seasonsEnabled, setSeasonsEnabled] = useState(false);

  // Форма входа показывается только по подтверждённому 401. Раньше сюда
  // приводила ЛЮБАЯ неудача запроса профиля: ответ 429 от ограничителя
  // частоты выглядел как выход из аккаунта, и человек начинал вводить пароль
  // заново — в тот же исчерпанный лимит.
  const { checking, failure, retry } = useSessionCheck(() => api.me(), {
    onReady: (user) => {
      setMe(user);
      // Отказ здесь не должен ломать кабинет: без ответа пункты остаются
      // скрытыми — это безопасная сторона.
      void api
        .featureFlags()
        .then((flags) =>
          setSeasonsEnabled(flags.some((f) => f.key === 'seasons.enabled' && f.enabled)),
        )
        .catch(() => setSeasonsEnabled(false));
      return true;
    },
    onAbsent: () => setMe(null),
  });

  if (checking) {
    return (
      <div className="spinner" style={{ padding: 40 }}>
        Загрузка…
      </div>
    );
  }

  if (failure) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <SessionCheckFailed failure={failure} onRetry={retry} busy={checking} />
      </div>
    );
  }

  if (!me) {
    return <LoginPage onLoggedIn={retry} />;
  }

  const isAdmin = me.roles.includes('admin');

  return (
    <>
      <style>{UI_KEYFRAMES}</style>
      {/*
        Шапка — такая же, как в остальных кабинетах, и по той же причине, по
        какой карточка проекта стала одной на три поверхности: одинаковые вещи
        должны выглядеть одинаково. Раньше админка отличалась целиком, а выход
        прятался в левом нижнем углу боковой колонки — там его ищут в
        последнюю очередь.

        Обёртка `admin-topbar` снимает ограничение ширины: у кабинетов
        содержимое в колонке по центру, здесь — сетка с боковым меню во всю
        ширину, и центрированная шапка над ней выглядела бы съехавшей.
      */}
      <div className="admin-topbar" ref={topbarRef}>
        <NovaTopBar
          title="Пятый элемент"
          subtitle="Административный кабинет"
          icon="shield"
          actions={
            <>
              {/*
                Имя и аватар — вход в профиль. Роль остаётся подписью рядом:
                это не ссылка, а признак, и нажимать на него незачем.
              */}
              <ProfileLink
                name={me.displayName}
                avatar={me.avatarUrl ? { urls: { sm: me.avatarUrl } } : null}
                href={`${import.meta.env.BASE_URL.replace(/\/$/, '')}/profile`}
                onNavigate={() => navigate('/profile')}
              />
              <span className="u-hide-narrow small muted">
                · {isAdmin ? 'администратор' : me.roles.join(', ')}
              </span>
              <Button
                variant="secondary"
                onClick={() => {
                  void api.logout().then(() => setMe(null));
                }}
              >
                <Icon name="logout" size={16} />
                Выйти
              </Button>
            </>
          }
        />
      </div>
      <div className="layout">
        <nav className="sidebar" aria-label="Разделы кабинета">
          {/*
            Меню разбито на группы по ответственности, а не по алфавиту и не по
            порядку появления. Плоский список из шестнадцати пунктов заставлял
            читать его целиком каждый раз: «Комиссии» между «Пакетами раунда» и
            «Сделками» ищутся глазами, а не узнаются.

            Группа — это ответ на вопрос «чем я сейчас занят»: разбираю людей,
            считаю деньги, веду заявки, пишу тексты, настраиваю платформу.
          */}
          <NavGroup title="Пользователи и контроль">
            <NavItem to="/users" label="Пользователи" />
            <NavItem to="/compliance" label="Комплаенс" />
            <NavItem to="/access" label="Доступ" />
          </NavGroup>

          <NavGroup title="Коммерция">
            <NavItem to="/plans" label="Тарифы" />
            <NavItem to="/subscriptions" label="Подписки" />
            <NavItem to="/commission" label="Комиссии" />
          </NavGroup>

          <NavGroup title="Заявки и сделки">
            <NavItem to="/deals" label="Сделки" />
            <NavItem to="/questions" label="Вопросы заявки" />
            <NavItem to="/application-settings" label="Настройки заявки" />
            <NavItem to="/round-packages" label="Пакеты раунда" />
          </NavGroup>

          {/*
            Market Intelligence — сведения о рынке для маркетинга и поиска
            инвесторов. Не работа с участниками платформы, поэтому своя группа.
          */}
          {isAdmin ? (
            <NavGroup title="Рынок">
              <NavItem to="/intelligence" label="Market Intelligence" />
            </NavGroup>
          ) : null}

          <NavGroup title="Коммуникации">
            <NavItem to="/templates" label="Уведомления" />
            <NavItem to="/support" label="Поддержка" />
          </NavGroup>

          {/*
            Сезоны отложены (M088). Группа появляется целиком вместе с флагом —
            и исчезает целиком: пункт сезона среди настроек платформы выглядел
            бы настройкой, а это отдельное направление работы.
          */}
          {seasonsEnabled ? (
            <NavGroup title="Сезон">
              <NavItem to="/season" label="Сезон" />
              <NavItem to="/funnel" label="Воронка сезона" />
            </NavGroup>
          ) : null}

          {/*
            Проверка — не настройка и не работа с людьми: это инструмент,
            которым платформу проходят насквозь. Поэтому своя группа, а не
            пункт среди справочников.
          */}
          <NavGroup title="Проверка">
            <NavItem to="/testing" label="Тестовые сессии" />
            <NavItem to="/ui" label="Элементы интерфейса" />
          </NavGroup>

          <NavGroup title="Настройки платформы">
            <NavItem to="/integrations" label="Интеграции" />
            <NavItem to="/texts" label="Словарь и ЧАВО" />
            <NavItem to="/service-countries" label="Страны обслуживания" />
            <NavItem to="/flags" label="Функции платформы" />
            {/*
              Консоль — отдельное приложение, не маршрут этого кабинета, поэтому
              обычная ссылка, а не NavLink. Пункт виден только администратору:
              остальным сервер всё равно ответит 404 (привратник auth_request в
              infra/nginx/local/console.conf), и пустая ссылка в меню выглядела
              бы поломкой.
            */}
            {isAdmin ? (
              <a className="navlink" href={consoleHref()} target="_blank" rel="noreferrer">
                Консоль API
              </a>
            ) : null}
          </NavGroup>
        </nav>

        <main className="content">
          {!isAdmin && (
            <div className="alert alert--error">
              У этой учётной записи нет роли администратора. Экраны доступны только на чтение, а
              операции сервер отклонит.
            </div>
          )}
          <Routes>
            <Route path="/" element={<Navigate to="/plans" replace />} />
            <Route
              path="/profile"
              element={
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
                  // Проверка личности администратору через кабинет не подаётся:
                  // его допуск — роль, а не KYC. Блока нет намеренно.
                  onPasswordChanged={() => {
                    // Сессии закрыты все, включая эту: остаёмся на форме входа
                    // самой админки.
                    setMe(null);
                    window.location.reload();
                  }}
                />
              }
            />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/users/:id" element={<UserCardPage />} />
            <Route path="/plans" element={<PlansPage />} />
            <Route path="/subscriptions" element={<SubscriptionsPage />} />
            <Route path="/compliance" element={<CompliancePage />} />
            <Route path="/season" element={<SeasonPage />} />
            <Route path="/funnel" element={<FunnelPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/support" element={<SupportPage />} />
            <Route path="/support/:id" element={<SupportPage />} />
            <Route path="/integrations" element={<IntegrationsPage />} />
            <Route path="/questions" element={<QuestionsPage />} />
            <Route path="/application-settings" element={<ApplicationSettingsPage />} />
            <Route path="/texts" element={<TextsPage />} />
            <Route path="/service-countries" element={<ServiceCountriesPage />} />
            <Route path="/round-packages" element={<RoundPackagesPage />} />
            <Route path="/commission" element={<CommissionPage />} />
            <Route path="/deals" element={<DealsPage />} />
            <Route path="/flags" element={<FlagsPage />} />
            <Route path="/testing" element={<TestingSessionsPage />} />
            <Route path="/ui" element={<UiCatalogPage />} />
            <Route path="/access" element={<AccessPage />} />
            <Route path="/intelligence" element={<IntelligencePage />} />
            <Route
              path="/intelligence/platforms"
              element={<IntelligenceSourcesPage platformsOnly />}
            />
            <Route
              path="/intelligence/telegram"
              element={<IntelligenceSourcesPage telegramOnly />}
            />
            <Route path="/intelligence/sources" element={<IntelligenceSourcesPage />} />
            <Route path="/intelligence/sources/:id" element={<IntelligenceSourceCardPage />} />
            <Route path="/intelligence/:id" element={<IntelligenceCardPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
    </>
  );
}

/**
 * Неизвестный адрес.
 *
 * Раньше любой неверный путь молча вёл на «Тарифы». Это выглядело как
 * «экран сломался и подсунул другой»: человек, пришедший по ссылке из письма
 * на карточку пользователя, оказывался в прейскуранте и не понимал, почему.
 * Теперь адрес назван, и из тупика есть выход.
 */
function NotFoundPage() {
  return (
    <div data-page="not-found">
      <div className="page-head">
        <h1>Такой страницы нет</h1>
      </div>
      <p className="page-hint">
        Адрес <code>{window.location.pathname}</code> административному кабинету неизвестен.
        Проверьте ссылку — возможно, раздел переименован или адрес скопирован не целиком.
      </p>
      <Link to="/users" className="btn--ghost btn--sm" style={{ textDecoration: 'none' }}>
        К списку пользователей
      </Link>
    </div>
  );
}

/** Порт консоли, подставленный сборкой (`vite.config.ts`, define). */
declare const __CONSOLE_PORT__: number;

/**
 * Адрес служебной консоли.
 *
 * За единой точкой входа консоль открыта ПО ПУТИ. При прямом запуске
 * dev-сервером путь `/console/` вёл бы на несуществующий маршрут ТОГО ЖЕ
 * сервера: приложения поднимаются отдельно, — поэтому там нужен порт.
 *
 * Различает эти случаи сборка: при относительном адресе API она кладёт в
 * `__CONSOLE_PORT__` ноль. Пустой порт страницы признаком НЕ является — у
 * временного контура проверок вход стоит на 8081, и ссылка уводила на
 * localhost:5178, которого там нет. Тот же приём, что у переходов между
 * кабинетами.
 */
function consoleHref(): string {
  const { protocol, hostname, port } = window.location;
  if (port === '' || !__CONSOLE_PORT__) return '/console/';
  return `${protocol}//${hostname}:${__CONSOLE_PORT__}/console/`;
}

/**
 * Группа пунктов меню.
 *
 * Заголовок — не декорация: без него группировка читается как случайные
 * пробелы между ссылками. Разметка списком, а не набором ссылок подряд:
 * чтение с клавиатуры и экранным диктором должно сообщать, сколько пунктов в
 * разделе и где он кончается.
 */
function NavGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="nav-group" role="group" aria-label={title}>
      <div className="nav-group__title">{title}</div>
      {/*
        Пункты в своей обёртке не ради вёрстки: на ней держится направляющая —
        вертикальная линия слева, которая показывает, докуда группа
        простирается. Заголовок называет группу, линия обозначает её границы.
      */}
      <div className="nav-group__items">{children}</div>
    </div>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => `navlink${isActive ? ' navlink--active' : ''}`}>
      {label}
    </NavLink>
  );
}
