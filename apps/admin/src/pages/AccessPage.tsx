import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Stack,
} from '@unicorn/ui';
import type { AdminUserSummary } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { CapabilitiesSection } from './StaffAccessSections';

/**
 * Управление доступом: роли пользователей и сервисные клиенты внешних систем.
 *
 * Два самых весомых действия администратора собраны на одном экране намеренно:
 * и роль, и клиент Integration API — это раздача прав, а не редактирование
 * справочника. Оба сопровождаются напоминанием о том, чего интерфейс сделать
 * не может: снять роль себе, разжаловать последнего администратора, показать
 * секрет повторно.
 */
export function AccessPage() {
  return (
    <Stack gap="var(--u-space-6)">
      <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>Доступ</h1>
      <RolesSection />
      {/*
        Дальше — второе условие доступа. Роль отвечает на вопрос «кто он»,
        полномочие — «что вправе делать». Назначения на объект (оценка проекта,
        сопровождение сделки) удалены в 2.1-W05 вместе с экспертизой и сделками.
      */}
      <CapabilitiesSection />
      {/* Клиенты Integration API переехали в «Интеграции»: там всё внешнее в одном месте. */}
    </Stack>
  );
}

function RolesSection() {
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');
  const [found, setFound] = useState<AdminUserSummary[] | null>(null);
  const [role, setRole] = useState('investor');
  const [items, setItems] = useState<
    { role: string; grantedAt: string; revokedAt: string | null }[]
  >([]);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<{ items: typeof items }>, okText: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const result = await action();
        setItems(result.items);
        setNotice({ tone: 'ok', text: okText });
      } catch (error) {
        setNotice({
          tone: 'error',
          text:
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Сервис недоступен',
        });
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Роли пользователя</h2>
        <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          Выдать роль себе нельзя, снять роль у последнего администратора — тоже. Каждое изменение
          попадает в журнал вместе с тем, кто его сделал.
        </span>

        {/*
          Поиск по имени вместо ввода UUID руками.

          Идентификатор остаётся тем, чем оперирует API — он однозначен и попадает
          в журнал. Но взять его оператору было негде: экран просил «UUID из базы»,
          а базы у оператора нет. Теперь он ищет человека по имени и выбирает из
          найденных; поле идентификатора остаётся видимым и заполняется выбором —
          сверить его с журналом по-прежнему можно.
        */}
        <Field
          label="Найти человека"
          htmlFor="role-search"
          hint="По имени, как оно указано в профиле"
        >
          <div style={{ display: 'flex', gap: 'var(--u-space-2)' }}>
            <Input
              id="role-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Например, Оливер"
            />
            <button
              type="button"
              className="btn--sm"
              onClick={() => {
                setFound(null);
                void api
                  .searchUsers(search.trim())
                  .then((page) => setFound(page.items))
                  .catch(() => setFound([]));
              }}
            >
              Искать
            </button>
          </div>
        </Field>

        {found !== null && found.length === 0 ? (
          <div className="small muted">Никого не нашлось — попробуйте другую часть имени.</div>
        ) : null}

        {found !== null && found.length > 0 ? (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--u-space-2)',
            }}
          >
            {found.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === userId ? 'btn--sm' : 'btn--ghost btn--sm'}
                  style={{ width: '100%', textAlign: 'left' }}
                  onClick={() => setUserId(item.id)}
                >
                  {item.displayName}
                  <span className="small muted">
                    {' '}
                    · {item.roles.length > 0 ? item.roles.join(', ') : 'без ролей'} ·{' '}
                    {item.id.slice(0, 8)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <Field
          label="Идентификатор пользователя"
          htmlFor="role-user"
          hint="Заполняется выбором из поиска"
        >
          <Input
            id="role-user"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="019f…"
          />
        </Field>

        <Field label="Роль" htmlFor="role-name">
          <select
            id="role-name"
            value={role}
            onChange={(event) => setRole(event.target.value)}
            style={SELECT_STYLE}
          >
            <option value="admin">администратор</option>
            <option value="investor">инвестор</option>
            <option value="founder">основатель</option>
          </select>
        </Field>

        <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
          <Button
            loading={busy}
            disabled={!userId}
            onClick={() => void run(() => api.listRoles(userId), 'Роли загружены')}
            variant="secondary"
          >
            Показать роли
          </Button>
          <Button
            loading={busy}
            disabled={!userId}
            onClick={() => void run(() => api.grantRole(userId, role), 'Роль выдана')}
          >
            Выдать
          </Button>
          <Button
            loading={busy}
            disabled={!userId}
            variant="danger"
            onClick={() => void run(() => api.revokeRole(userId, role), 'Роль снята')}
          >
            Снять
          </Button>
        </div>

        {notice ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={{
              padding: 'var(--u-space-3)',
              borderRadius: 'var(--u-radius-md)',
              background:
                notice.tone === 'error' ? 'var(--u-danger-subtle)' : 'var(--u-success-subtle)',
              color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)',
            }}
          >
            {notice.text}
          </div>
        ) : null}

        {items.length > 0 ? (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--u-space-2)',
            }}
          >
            {items.map((item) => (
              <li
                key={`${item.role}-${item.grantedAt}`}
                style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center' }}
              >
                <Badge tone={item.revokedAt ? 'neutral' : 'success'}>{item.role}</Badge>
                <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                  выдана {new Date(item.grantedAt).toLocaleDateString('ru-RU')}
                  {item.revokedAt
                    ? `, снята ${new Date(item.revokedAt).toLocaleDateString('ru-RU')}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * Сервисные клиенты Integration API.
 *
 * Секрет показывается ровно один раз — при создании и при ротации. Это не
 * недоработка интерфейса: в базе лежит только Argon2id-хеш, и «показать ещё
 * раз» невозможно by design.
 */
export function ServiceAccountsSection() {
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'ready';
        items: { id: string; clientId: string; name: string; scopes: string[]; status: string }[];
      }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [secret, setSecret] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [clientId, setClientId] = useState('');
  const [scopes, setScopes] = useState('graduates:read');
  const [fingerprint, setFingerprint] = useState('');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const { items } = await api.serviceAccounts();
      setState({ status: 'ready', items });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Клиенты Integration API</h2>

        {state.status === 'loading' ? <LoadingState label="Загружаем клиентов" /> : null}
        {state.status === 'error' ? (
          <ErrorState description={state.message} onRetry={() => void load()} />
        ) : null}

        {state.status === 'ready' && state.items.length === 0 ? (
          <EmptyState
            title="Клиентов нет"
            description="Клиент внешней системы создаётся здесь; секрет выдаётся один раз и хранится только в виде хеша."
          />
        ) : null}

        {state.status === 'ready' && state.items.length > 0 ? (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--u-space-3)',
            }}
          >
            {state.items.map((account) => (
              <li key={account.id}>
                <div style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
                  <div style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}>
                    <Badge tone={account.status === 'active' ? 'success' : 'warning'}>
                      {account.status}
                    </Badge>
                    <strong>{account.name}</strong>
                    <code style={{ fontSize: 'var(--u-text-xs)' }}>{account.clientId}</code>
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                    {account.scopes.map((scope) => (
                      <Badge key={scope}>{scope}</Badge>
                    ))}
                  </div>
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      try {
                        const rotated = await api.rotateServiceAccount(account.id);
                        setSecret(rotated.clientSecret);
                        await load();
                      } catch (error) {
                        setSecret(null);
                        setState({
                          status: 'error',
                          message:
                            error instanceof ApiError
                              ? (error.problem?.detail ?? error.message)
                              : 'Сервис недоступен',
                        });
                      }
                    }}
                  >
                    Ротировать секрет
                  </Button>
                  {/*
                    Приостановка — не удаление. Выданные токены перестают
                    действовать по эпохе, а сам клиент со скоупами остаётся, и
                    доступ возвращается одним действием. Удалять клиента,
                    которого приостановили на время разбирательства, значило бы
                    заставить контрагента перевыпускать секрет.
                  */}
                  <Button
                    variant={account.status === 'active' ? 'danger' : 'secondary'}
                    onClick={async () => {
                      try {
                        await api.setServiceAccountStatus(
                          account.id,
                          account.status === 'active' ? 'suspended' : 'active',
                        );
                        await load();
                      } catch (error) {
                        setState({
                          status: 'error',
                          message:
                            error instanceof ApiError
                              ? (error.problem?.detail ?? error.message)
                              : 'Сервис недоступен',
                        });
                      }
                    }}
                  >
                    {account.status === 'active' ? 'Приостановить' : 'Возобновить'}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : null}

        <div
          style={{
            borderTop: '1px solid var(--u-border)',
            paddingTop: 'var(--u-space-3)',
            display: 'grid',
            gap: 'var(--u-space-2)',
          }}
        >
          <strong>Новый клиент</strong>
          <Field label="Название" htmlFor="sa-name">
            <Input id="sa-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field
            label="Идентификатор клиента"
            htmlFor="sa-client-id"
            hint="Строчные латинские буквы, цифры и . _ - ; 3–64 символа"
          >
            <Input
              id="sa-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </Field>
          <Field
            label="Скоупы"
            htmlFor="sa-scopes"
            hint="Через запятую. Скоуп — это право на конкретные события и данные, а не на всё сразу."
          >
            <Input id="sa-scopes" value={scopes} onChange={(e) => setScopes(e.target.value)} />
          </Field>
          <Field
            label="Отпечаток клиентского сертификата"
            htmlFor="sa-fingerprint"
            hint="sha256 в hex, 64 символа. Без mTLS клиент к Integration API не допускается."
          >
            <Input
              id="sa-fingerprint"
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
            />
          </Field>
          <Button
            onClick={async () => {
              try {
                const created = await api.createServiceAccount({
                  name: name.trim(),
                  clientId: clientId.trim(),
                  scopes: scopes
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                  mtlsCertFingerprint: fingerprint.trim(),
                });
                // Секрет показывается ОДИН раз — здесь же, где и после ротации.
                setSecret(created.clientSecret);
                setName('');
                setClientId('');
                setScopes('');
                setFingerprint('');
                await load();
              } catch (error) {
                setSecret(null);
                setState({
                  status: 'error',
                  message:
                    error instanceof ApiError
                      ? (error.problem?.detail ?? error.message)
                      : 'Сервис недоступен',
                });
              }
            }}
          >
            Создать клиента
          </Button>
        </div>

        {secret ? (
          <div
            role="status"
            style={{
              padding: 'var(--u-space-4)',
              borderRadius: 'var(--u-radius-md)',
              border: '1px solid var(--u-warning)',
              background: 'var(--u-warning-subtle)',
            }}
          >
            <Stack gap="var(--u-space-2)">
              <strong>Секрет клиента — скопируйте сейчас</strong>
              <code style={{ wordBreak: 'break-all' }}>{secret}</code>
              <span style={{ fontSize: 'var(--u-text-sm)' }}>
                Повторно он не отображается: в базе хранится только хеш. Потеряли — ротируйте снова.
              </span>
              <Button variant="secondary" onClick={() => setSecret(null)}>
                Скрыть
              </Button>
            </Stack>
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

const SELECT_STYLE: React.CSSProperties = {
  minHeight: 44,
  padding: '0 var(--u-space-3)',
  borderRadius: 'var(--u-radius-md)',
  border: '1px solid var(--u-border-strong)',
  background: 'var(--u-surface)',
  color: 'var(--u-text)',
  fontSize: 'var(--u-text-md)',
  fontFamily: 'inherit',
  width: '100%',
};
