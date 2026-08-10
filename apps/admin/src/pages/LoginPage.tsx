import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';

/**
 * Вход в кабинет.
 *
 * Ошибка входа всегда одна и та же вне зависимости от причины: сообщать
 * «такого пользователя нет» значит помогать перебирать адреса. Сервер уже
 * отвечает одинаково — интерфейс не должен это различие изобретать.
 */
export function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email.trim(), password);
      onLoggedIn();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Слишком много попыток входа. Повторите через минуту.'
          : 'Не удалось войти. Проверьте адрес и пароль.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1>Административный кабинет</h1>
        <p className="page-hint">
          Доступ только для учётных записей с ролью администратора. Все действия записываются в
          неизменяемый журнал.
        </p>

        {error && <div className="alert alert--error">{error}</div>}

        <div className="field">
          <label htmlFor="email">Электронная почта</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Пароль</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <button type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Проверяем…' : 'Войти'}
        </button>
      </form>
    </div>
  );
}
