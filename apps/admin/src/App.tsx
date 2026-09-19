import { useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
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
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar__brand">
          Пятый элемент
          <span>административный кабинет</span>
        </div>
        <NavItem to="/plans" label="Тарифы" />
        <NavItem to="/subscriptions" label="Подписки" />
        <NavItem to="/compliance" label="Комплаенс" />
        {seasonsEnabled ? (
          <>
            <NavItem to="/season" label="Сезон" />
            <NavItem to="/funnel" label="Воронка сезона" />
          </>
        ) : null}
        <NavItem to="/templates" label="Уведомления" />
        <NavItem to="/support" label="Поддержка" />
        <NavItem to="/integrations" label="Интеграции" />
        <NavItem to="/questions" label="Вопросы заявки" />
        <NavItem to="/application-settings" label="Настройки заявки" />
        <NavItem to="/texts" label="Словарь и ЧАВО" />
        <NavItem to="/service-countries" label="Страны обслуживания" />
        <NavItem to="/round-packages" label="Пакеты раунда" />
        <NavItem to="/commission" label="Комиссии" />
        <NavItem to="/deals" label="Сделки" />
        <NavItem to="/flags" label="Функции платформы" />
        <NavItem to="/access" label="Доступ" />
        {/*
          Консоль — отдельное приложение, не маршрут этого кабинета, поэтому
          обычная ссылка, а не NavLink. Пункт виден только администратору:
          остальным сервер всё равно ответит 404 (привратник auth_request в
          infra/nginx/local/console.conf), и пустая ссылка в меню выглядела бы
          поломкой.
        */}
        {isAdmin ? (
          <a className="navlink" href={consoleHref()} target="_blank" rel="noreferrer">
            Консоль API
          </a>
        ) : null}
        <div className="sidebar__footer">
          <div>{me.displayName}</div>
          <div className="small muted" style={{ marginBottom: 8 }}>
            {isAdmin ? 'администратор' : me.roles.join(', ')}
          </div>
          <button
            type="button"
            className="btn--ghost btn--sm"
            onClick={() => {
              void api.logout().then(() => setMe(null));
            }}
          >
            Выйти
          </button>
        </div>
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
          <Route path="*" element={<Navigate to="/plans" replace />} />
        </Routes>
      </main>
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

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink to={to} className={({ isActive }) => `navlink${isActive ? ' navlink--active' : ''}`}>
      {label}
    </NavLink>
  );
}
