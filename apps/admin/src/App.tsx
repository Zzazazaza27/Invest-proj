import { useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { Button, Icon, IconTile, NovaTopBar, UI_KEYFRAMES } from '@unicorn/ui';
import { SessionCheckFailed, useSessionCheck } from '@unicorn/cabinet';
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
import { UserCardPage } from './pages/UserCardPage';

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
}

export function App() {
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
      <div className="admin-topbar">
        <NovaTopBar
          title="Пятый элемент"
          subtitle="Административный кабинет"
          icon="shield"
          actions={
            <>
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
                <span style={{ opacity: 0.7 }}>
                  · {isAdmin ? 'администратор' : me.roles.join(', ')}
                </span>
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
            <Route path="/access" element={<AccessPage />} />
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
 * За единой точкой входа порта в адресе страницы нет — тогда консоль открыта
 * по пути. При прямом запуске dev-сервером порт есть, и путь `/console/` вёл
 * бы на несуществующий маршрут ТОГО ЖЕ сервера: приложения поднимаются
 * отдельно. Тот же приём, что у переходов между кабинетами.
 */
function consoleHref(): string {
  const { protocol, hostname, port } = window.location;
  return port === '' ? '/console/' : `${protocol}//${hostname}:${__CONSOLE_PORT__}/console/`;
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
      {children}
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
