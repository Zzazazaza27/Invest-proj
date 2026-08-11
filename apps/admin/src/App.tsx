import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { ApiError, api } from './api';
import { LoginPage } from './pages/LoginPage';
import { PlansPage } from './pages/PlansPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { FlagsPage } from './pages/FlagsPage';
import { CompliancePage } from './pages/CompliancePage';
import { SeasonPage } from './pages/SeasonPage';
import { AccessPage } from './pages/AccessPage';

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
  const [checking, setChecking] = useState(true);

  const load = useCallback(async () => {
    try {
      const user = await api.me();
      setMe(user);
    } catch (error) {
      // 401 здесь — норма: пользователь просто не вошёл.
      if (!(error instanceof ApiError) || error.status !== 401) {
        console.warn('не удалось получить профиль', error);
      }
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (checking) {
    return (
      <div className="spinner" style={{ padding: 40 }}>
        Загрузка…
      </div>
    );
  }

  if (!me) {
    return <LoginPage onLoggedIn={() => void load()} />;
  }

  const isAdmin = me.roles.includes('admin');

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar__brand">
          UNICORN LAUNCH
          <span>административный кабинет</span>
        </div>
        <NavItem to="/plans" label="Тарифы" />
        <NavItem to="/subscriptions" label="Подписки" />
        <NavItem to="/compliance" label="Комплаенс" />
        <NavItem to="/season" label="Сезон" />
        <NavItem to="/flags" label="Функции платформы" />
        <NavItem to="/access" label="Доступ" />
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
          <Route path="/subscriptions" element={<SubscriptionsPage adminId={me.id} />} />
          <Route path="/compliance" element={<CompliancePage />} />
          <Route path="/season" element={<SeasonPage />} />
          <Route path="/flags" element={<FlagsPage />} />
          <Route path="/access" element={<AccessPage />} />
          <Route path="*" element={<Navigate to="/plans" replace />} />
        </Routes>
      </main>
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
