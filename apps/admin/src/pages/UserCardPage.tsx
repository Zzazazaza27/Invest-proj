import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button } from '@fifth/ui';
import type { AdminUserCard } from '@fifth/contracts';
import { ApiError, api } from '../api';
import {
  Avatar,
  KYC_LABEL,
  ORIGIN_LABEL,
  ROLE_LABEL,
  STATUS_LABEL,
  ViewCabinetAction,
  statusTone,
} from './users-shared';

/**
 * Карточка человека — рабочий экран администратора.
 *
 * Что здесь есть и чего нет, решено не удобством вёрстки, а тем, за что
 * отвечает администратор:
 *
 *  * **есть** — состояние учётной записи и как его изменить, права (роли,
 *    полномочия, назначения), связанные объекты и история действий;
 *  * **нет** — универсального редактора полей. Меняется ровно одно обычное
 *    поле, отображаемое имя. Подтверждённые контакты и данные личности
 *    показываются, но перезаписать их отсюда нельзя: у них свои процессы, и
 *    «правка в карточке» обесценила бы проверку;
 *  * **по кнопке** — контакт целиком. Раскрытие требует полномочия и
 *    попадает в журнал, поэтому оно действие, а не поле.
 */
export function UserCardPage() {
  const { id = '' } = useParams();
  const [card, setCard] = useState<AdminUserCard | null>(null);
  const [error, setError] = useState<{ text: string; notFound: boolean } | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [contacts, setContacts] = useState<{ email: string | null; phone: string | null } | null>(
    null,
  );

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setCard(await api.adminUserCard(id));
    } catch (cause) {
      const status = cause instanceof ApiError ? cause.status : 0;
      setError({
        text:
          status === 404
            ? 'Пользователь не найден. Возможно, учётная запись удалена или ссылка устарела.'
            : cause instanceof ApiError
              ? (cause.problem?.detail ?? cause.message)
              : 'Карточка не загрузилась',
        notFound: status === 404,
      });
    } finally {
      setBusy(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Общая обёртка действий: один и тот же разбор ошибки на все кнопки. */
  const run = useCallback(
    async (action: () => Promise<AdminUserCard | void>, okText: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const next = await action();
        if (next) setCard(next);
        else await load();
        setNotice({ tone: 'ok', text: okText });
      } catch (cause) {
        setNotice({
          tone: 'error',
          text:
            cause instanceof ApiError
              ? (cause.problem?.detail ?? cause.message)
              : 'Действие не выполнено',
        });
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (busy && !card) return <div className="spinner">Загружаем карточку…</div>;

  if (error) {
    return (
      <div data-page="user-card">
        <div className="page-head">
          <h1>{error.notFound ? 'Пользователь не найден' : 'Карточка недоступна'}</h1>
        </div>
        <p className="page-hint" data-user-missing>
          {error.text}
        </p>
        {/* Переход на другую страницу — ссылка, а не кнопка. */}
        <Link to="/users" className="small">
          ← Пользователи
        </Link>
      </div>
    );
  }

  if (!card) return null;

  return (
    <div data-page="user-card" data-user-id={card.id}>
      {/* Возврат — над заголовком слева, как на остальных страницах-карточках. */}
      <Link
        to="/users"
        className="small"
        data-back-to-users
        style={{ display: 'inline-block', marginBottom: 8 }}
      >
        ← Пользователи
      </Link>
      <div className="page-head">
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', minWidth: 0 }}>
          <Avatar user={card} size={48} raised />
          <div style={{ minWidth: 0 }}>
            <h1 style={{ marginBottom: 2 }}>{card.displayName}</h1>
            <div className="small muted">
              <span className={`badge badge--${statusTone(card.status)}`} data-user-status>
                {STATUS_LABEL[card.status] ?? card.status}
              </span>{' '}
              · {ROLE_LABEL[card.primaryRole] ?? card.primaryRole}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {/*
            То же действие, что и в строке списка: человек, открывший
            карточку, не должен возвращаться к списку ради просмотра.
          */}
          <ViewCabinetAction
            userId={card.id}
            roles={card.roles.filter((item) => item.revokedAt === null).map((item) => item.role)}
          />
        </div>
      </div>

      {notice ? (
        <Alert
          tone={notice.tone === 'ok' ? 'success' : 'danger'}
          size="sm"
          data-user-notice
          style={{ marginBottom: 12 }}
        >
          {notice.text}
        </Alert>
      ) : null}

      <StatusSection card={card} busy={busy} run={run} />

      <section className="card" data-block="identity">
        <h2>Основные данные и контакты</h2>
        <NameEditor card={card} busy={busy} run={run} />
        <table>
          <tbody>
            <Row label="Почта">
              {contacts?.email ?? card.emailMasked ?? <span className="muted">не указана</span>}
            </Row>
            <Row label="Телефон">
              {contacts?.phone ?? card.phoneMasked ?? <span className="muted">не указан</span>}
            </Row>
            <Row label="Откуда запись">
              {ORIGIN_LABEL[card.origin] ?? card.origin}
              {card.origin !== 'self_registration' ? (
                <div className="small muted">
                  Проставлено при создании и не меняется: это факт, а не настройка.
                </div>
              ) : null}
            </Row>
            <Row label="Локаль">{card.locale}</Row>
            <Row label="Страна обслуживания">
              {card.serviceCountry ?? <span className="muted">не выбрана</span>}
            </Row>
            <Row label="Валюта">{card.currencyPref}</Row>
            <Row label="Второй фактор">{card.mfaEnabled ? 'включён' : 'выключен'}</Row>
            <Row label="Регистрация">{formatDateTime(card.createdAt)}</Row>
            <Row label="Изменён">{formatDateTime(card.updatedAt)}</Row>
            <Row label="Сессии действительны с">{formatDateTime(card.sessionsValidFrom)}</Row>
            {/* Идентификатор нужен поддержке и журналам, но не заголовку. */}
            <Row label="Идентификатор">
              <code className="small" data-user-id-value>
                {card.id}
              </code>
            </Row>
          </tbody>
        </table>
        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          {contacts ? (
            <span className="small muted" data-contacts-open>
              Контакт раскрыт — запись об этом уже в журнале.
            </span>
          ) : (
            <button
              type="button"
              className="btn--ghost btn--sm"
              data-reveal-contacts
              disabled={busy || !card.canRevealContacts}
              onClick={() =>
                void run(async () => {
                  setContacts(await api.revealUserContacts(card.id));
                }, 'Контакт раскрыт и записан в журнал')
              }
            >
              Показать контакт целиком
            </button>
          )}
          <span className="small muted">
            {card.canRevealContacts
              ? 'Раскрытие попадает в журнал вместе с тем, кто его сделал.'
              : 'Нет полномочия «видеть контактные данные».'}
          </span>
        </div>
      </section>

      <RolesSection card={card} busy={busy} run={run} />

      <section className="card" data-block="capabilities">
        <h2>Полномочия и назначения</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Полномочие отвечает на вопрос «что вправе делать», назначение — «с какими объектами».
          Выдаются на экране <Link to="/access">Доступ</Link>.
        </p>
        {card.capabilities.length === 0 ? (
          <div className="empty">Полномочий нет.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Полномочие</th>
                <th>Основание</th>
                <th>Выдано</th>
              </tr>
            </thead>
            <tbody>
              {card.capabilities.map((item) => (
                <tr key={item.capability}>
                  <td>{item.title}</td>
                  <td className="small">{item.reason}</td>
                  <td className="small num">{formatDate(item.grantedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" data-block="kyc">
        <h2>Проверка личности</h2>
        {card.kyc.length === 0 ? (
          <div className="empty">Проверок не было.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Вид</th>
                <th>Состояние</th>
                <th>Причина отказа</th>
                <th>Решение</th>
              </tr>
            </thead>
            <tbody>
              {card.kyc.map((item) => (
                <tr key={item.id}>
                  <td className="small">{item.kind}</td>
                  <td className="small">{KYC_LABEL[item.status] ?? item.status}</td>
                  <td className="small">
                    {item.rejectionReason ?? <span className="muted">—</span>}
                  </td>
                  <td className="small num">
                    {item.decidedAt ? formatDate(item.decidedAt) : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Решения по проверке принимаются в разделе <Link to="/compliance">Комплаенс</Link>. Из
          карточки статус не переписывается — это обесценило бы саму проверку.
        </p>
      </section>

      <section className="card" data-block="linked">
        <h2>Связанные объекты</h2>
        <div className="grid-2">
          <div>
            <h3 className="small" style={{ margin: '0 0 6px' }}>
              Проекты
            </h3>
            {card.projects.length === 0 ? (
              <p className="small muted">Нет.</p>
            ) : (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {card.projects.map((project) => (
                  <li key={project.id}>
                    {project.title} · {project.role} · {project.listingStatus}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="small" style={{ margin: '0 0 6px' }}>
              Юридические лица
            </h3>
            {card.entities.length === 0 ? (
              <p className="small muted">Нет.</p>
            ) : (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {card.entities.map((entity) => (
                  <li key={entity.id}>
                    {entity.legalName} · {entity.jurisdiction} · {entity.registryStatus}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
          Обращений в поддержку: {card.supportTickets}.
        </p>
      </section>

      <section className="card" data-block="history">
        <h2>История административных действий</h2>
        {card.history.length === 0 ? (
          <div className="empty">Записей нет.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Когда</th>
                <th>Что</th>
                <th>Кто</th>
                <th>Подробности</th>
              </tr>
            </thead>
            <tbody>
              {card.history.map((entry, index) => (
                <tr key={`${entry.ts}-${index}`}>
                  <td className="small num">{formatDateTime(entry.ts)}</td>
                  <td className="small">{VERB_LABEL[entry.verb] ?? entry.verb}</td>
                  <td className="small">
                    {entry.actorName ?? <span className="muted">система</span>}
                  </td>
                  <td className="small">{describeContext(entry.context)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

/** Блок состояния: где блокируют и разблокируют, и где видно, почему. */
function StatusSection({
  card,
  busy,
  run,
}: {
  card: AdminUserCard;
  busy: boolean;
  run: (action: () => Promise<AdminUserCard | void>, okText: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const suspended = card.status === 'suspended';

  return (
    <section className="card" data-block="status">
      <h2>Состояние учётной записи</h2>
      {card.statusReason ? (
        <p className="small" data-status-reason>
          <strong>{suspended ? 'Причина блокировки:' : 'Последнее изменение:'}</strong>{' '}
          {card.statusReason}
          {card.statusChangedByName ? ` — ${card.statusChangedByName}` : ''}
          {card.statusChangedAt ? `, ${formatDateTime(card.statusChangedAt)}` : ''}
        </p>
      ) : (
        <p className="small muted">Состояние не менялось администратором.</p>
      )}

      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                api.changeUserStatus(card.id, {
                  action: suspended ? 'restore' : 'suspend',
                  reason: reason.trim(),
                }),
              suspended ? 'Блокировка снята' : 'Учётная запись заблокирована',
            ).then(() => {
              setOpen(false);
              setReason('');
            });
          }}
        >
          <div className="field">
            <label htmlFor="status-reason">
              {suspended ? 'Основание для снятия блокировки' : 'Причина блокировки'}
            </label>
            <textarea
              id="status-reason"
              data-status-reason-input
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Коротко и по делу: это увидит тот, кто будет разбираться"
            />
            <div className="field__hint">
              {suspended
                ? 'Человек снова сможет войти. Прежние сессии всё равно закрыты.'
                : 'Человек не сможет войти, а уже открытые сессии закроются немедленно.'}
            </div>
          </div>
          <div className="row-actions" style={{ justifyContent: 'flex-start' }}>
            <Button
              type="submit"
              size="sm"
              // Последний шаг блокировки — заливка; открывающая кнопка ниже — контур.
              variant={suspended ? 'primary' : 'danger-confirm'}
              data-status-confirm
              disabled={busy || reason.trim().length < 3}
            >
              {suspended ? 'Снять блокировку' : 'Заблокировать'}
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={() => setOpen(false)}>
              Отмена
            </Button>
          </div>
        </form>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={suspended ? 'primary' : 'danger'}
          data-status-open
          disabled={busy}
          onClick={() => setOpen(true)}
        >
          {suspended ? 'Снять блокировку' : 'Заблокировать'}
        </Button>
      )}
    </section>
  );
}

/** Правка единственного обычного поля. Форма появляется по нажатию. */
function NameEditor({
  card,
  busy,
  run,
}: {
  card: AdminUserCard;
  busy: boolean;
  run: (action: () => Promise<AdminUserCard | void>, okText: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(card.displayName);

  if (!open) {
    return (
      <div className="toolbar">
        <button
          type="button"
          className="btn--ghost btn--sm"
          data-edit-name
          onClick={() => {
            setValue(card.displayName);
            setOpen(true);
          }}
        >
          Изменить имя
        </button>
        <span className="small muted">
          Отображаемое имя — единственное обычное поле профиля. Остальное меняют процессы, а не
          карточка.
        </span>
      </div>
    );
  }

  return (
    <form
      className="toolbar"
      onSubmit={(event) => {
        event.preventDefault();
        void run(
          () => api.updateUserProfile(card.id, { displayName: value.trim() }),
          'Имя изменено',
        ).then(() => setOpen(false));
      }}
    >
      <input
        aria-label="Отображаемое имя"
        data-name-input
        value={value}
        onChange={(event) => setValue(event.target.value)}
        style={{ width: 'min(320px, 100%)' }}
      />
      <button type="submit" className="btn--sm" disabled={busy || value.trim().length < 2}>
        Сохранить
      </button>
      <button type="button" className="btn--ghost btn--sm" onClick={() => setOpen(false)}>
        Отмена
      </button>
    </form>
  );
}

/**
 * Роли прямо в карточке.
 *
 * Серверная логика та же, что на экране «Доступ» — те же маршруты и те же
 * запреты (не себе, последнего администратора не снять). Экран не дублирует
 * правила, он их только вызывает.
 */
function RolesSection({
  card,
  busy,
  run,
}: {
  card: AdminUserCard;
  busy: boolean;
  run: (action: () => Promise<AdminUserCard | void>, okText: string) => Promise<void>;
}) {
  const [role, setRole] = useState('investor');
  const active = card.roles.filter((item) => item.revokedAt === null);

  return (
    <section className="card" data-block="roles">
      <h2>Роли</h2>
      {active.length === 0 ? (
        <p className="small muted">Ролей нет.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Роль</th>
              <th>Выдана</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {active.map((item) => (
              <tr key={item.role} data-role-row={item.role}>
                <td>{ROLE_LABEL[item.role] ?? item.role}</td>
                <td className="small num">{formatDate(item.grantedAt)}</td>
                <td className="row-actions">
                  <button
                    type="button"
                    className="btn--danger btn--sm"
                    data-revoke-role={item.role}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        async () => {
                          await api.revokeRole(card.id, item.role);
                        },
                        `Роль «${ROLE_LABEL[item.role] ?? item.role}» снята`,
                      )
                    }
                  >
                    Снять
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
        <select
          aria-label="Роль для выдачи"
          data-grant-role
          value={role}
          onChange={(event) => setRole(event.target.value)}
          style={{ width: 'auto' }}
        >
          {GRANTABLE_ROLES.map((value) => (
            <option key={value} value={value}>
              {ROLE_LABEL[value]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn--sm"
          data-grant-confirm
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api.grantRole(card.id, role);
            }, 'Роль выдана')
          }
        >
          Выдать роль
        </button>
        <span className="small muted">
          Себе роли не выдают, и последнего администратора не разжаловать — это проверяет сервер.
        </span>
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th style={{ width: 220, textTransform: 'none', fontSize: 13, letterSpacing: 0 }}>{label}</th>
      <td>{children}</td>
    </tr>
  );
}

const GRANTABLE_ROLES = ['admin', 'investor', 'founder'];

const VERB_LABEL: Record<string, string> = {
  'identity.role.granted': 'выдана роль',
  'identity.role.revoked': 'снята роль',
  'identity.user.suspended': 'заблокирован',
  'identity.user.restored': 'блокировка снята',
  'identity.user.profile_updated': 'изменено поле профиля',
  'identity.user_contacts.revealed': 'раскрыты контакты',
  'identity.user.registered': 'регистрация',
  'identity.password.changed': 'смена пароля',
  'identity.password.reset_completed': 'пароль восстановлен по ссылке',
  'identity.avatar.set': 'загружен аватар',
  'identity.avatar.removed': 'удалён аватар',
  'identity.login.failed': 'неудачная попытка входа',
  'identity.email.verification_sent': 'отправлено письмо подтверждения',
  'identity.email.verified': 'адрес подтверждён',
};

/** Контекст показывается словами: сырой JSON в интерфейсе читать некому. */
function describeContext(context: Record<string, unknown> | null): React.ReactNode {
  if (!context) return <span className="muted">—</span>;
  const parts: string[] = [];
  if (typeof context.role === 'string') parts.push(ROLE_LABEL[context.role] ?? context.role);
  if (typeof context.reason === 'string') parts.push(context.reason);
  if (typeof context.field === 'string') parts.push(`поле: ${context.field}`);
  if (context.email === true) parts.push('почта');
  if (context.phone === true) parts.push('телефон');
  return parts.length > 0 ? parts.join(' · ') : <span className="muted">—</span>;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('ru-RU');
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
