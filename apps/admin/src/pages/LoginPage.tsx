import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';

/**
 * Вход в кабинет.
 *
 * Ошибка входа всегда одна и та же вне зависимости от причины: сообщать
 * «такого пользователя нет» значит помогать перебирать адреса. Сервер уже
 * отвечает одинаково — интерфейс не должен это различие изобретать.
 */
/**
 * Внутренний домен для коротких логинов.
 *
 * Идентификатор пользователя в системе — адрес; отдельного поля «логин» в
 * схеме нет и заводить его ради удобства входа не стоит. Поэтому короткое имя
 * дополняется доменом здесь, на границе интерфейса, а сервер по-прежнему
 * получает адрес и ничего не знает про эту подстановку.
 */
const INTERNAL_DOMAIN = 'unicorn.local';

function toAddress(input: string): string {
  const value = input.trim();
  return value.includes('@') ? value : `${value}@${INTERNAL_DOMAIN}`;
}

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
      await api.login(toAddress(email), password);
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
          <label htmlFor="email">Логин или электронная почта</label>
          <input
            id="email"
            type="text"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <div className="field__hint">
            Короткий логин дополняется внутренним доменом автоматически.
          </div>
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
