import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AdminUserPage, AdminUserRow } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import {
  Avatar,
  KYC_LABEL,
  ORIGIN_LABEL,
  PROBE_ORIGIN,
  ViewCabinetAction,
  ROLE_LABEL,
  STATUS_LABEL,
  statusTone,
} from './users-shared';

/**
 * Раздел «Пользователи»: рабочий список людей.
 *
 * Чем он отличается от поиска на экране «Доступ», ради которого его и
 * заводили отдельно: там ищут одного человека, чтобы выдать ему роль, здесь
 * работают со всеми — смотрят, кто зарегистрировался, кто заблокирован, у
 * кого не пройдена проверка личности.
 *
 * Три решения, которые видны на экране:
 *
 *  1. **Поле поиска выбирается явно.** «Умный» поиск, угадывающий, что ему
 *     дали — имя, почту или идентификатор, — ошибается молча. Рядом с полем
 *     сказано, как именно оно ищет: по части имени, но по ПОЛНОМУ адресу,
 *     потому что контакты зашифрованы.
 *  2. **Отбор живёт в адресе страницы.** Перезагрузка, ссылка коллеге и
 *     возврат из карточки сохраняют то, что человек настроил.
 *  3. **Считает сервер.** Фильтры, сортировка и страницы — запрос в БД, а не
 *     фильтрация загруженной страницы, которая показывала бы «не найдено»
 *     там, где найденное просто на другой странице.
 */
export function UsersPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState<AdminUserPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  // Строка поиска — единственное, что живёт в состоянии до нажатия: запрос на
  // каждую букву дорогой, а по букве и результат бессмысленный.
  const [draft, setDraft] = useState(params.get('q') ?? '');

  const field = params.get('field') ?? 'name';
  const q = params.get('q') ?? '';
  const role = params.get('role') ?? '';
  const status = params.get('status') ?? '';
  const kyc = params.get('kyc') ?? '';
  // Умолчание — «настоящие»: следы прогонов прячутся, пока их не попросят.
  // Иначе список рассказывает не о людях платформы, а о наших проверках.
  const origin = params.get('origin') ?? 'real';
  const sort = params.get('sort') ?? 'created_at';
  const dir = params.get('dir') ?? 'desc';
  const current = Number(params.get('page') ?? '1');

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const query: Record<string, string> = {
        field,
        sort,
        dir,
        page: String(current),
        perPage: '25',
      };
      if (q) query.q = q;
      if (role) query.role = role;
      if (status) query.status = status;
      if (kyc) query.kyc = kyc;
      query.origin = origin;
      setPage(await api.adminUsers(query));
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? (cause.problem?.detail ?? cause.message)
          : 'Список не загрузился',
      );
    } finally {
      setBusy(false);
    }
  }, [field, q, role, status, kyc, origin, sort, dir, current]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Любая смена отбора возвращает на первую страницу: иначе «пусто» на пятой. */
  function apply(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === '') next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  }

  function sortBy(column: string) {
    // Повторное нажатие переворачивает порядок — привычное поведение таблицы.
    apply({ sort: column, dir: sort === column && dir === 'desc' ? 'asc' : 'desc' });
  }

  const total = page?.total ?? 0;
  const perPage = page?.perPage ?? 25;
  const pages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div data-page="users">
      <div className="page-head">
        <div>
          <h1>Пользователи</h1>
        </div>
      </div>
      <p className="page-hint">
        Кто зарегистрирован на платформе. Здесь работают с конкретным человеком: найти, открыть
        карточку, распорядиться учётной записью. Как устроены права платформы — в разделе{' '}
        <Link to="/access">Доступ</Link>.
      </p>

      <div className="card card--flat">
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ q: draft.trim() });
          }}
        >
          <select
            aria-label="Поле поиска"
            data-search-field
            value={field}
            onChange={(event) => apply({ field: event.target.value, q: '' })}
            style={{ width: 'auto' }}
          >
            <option value="name">по имени</option>
            <option value="email">по почте</option>
            <option value="phone">по телефону</option>
            <option value="id">по идентификатору</option>
          </select>
          <input
            aria-label="Что искать"
            data-search-input
            value={draft}
            placeholder={SEARCH_PLACEHOLDER[field] ?? ''}
            onChange={(event) => setDraft(event.target.value)}
            style={{ width: 'min(320px, 100%)' }}
          />
          <button type="submit" className="btn--sm">
            Искать
          </button>
          {q ? (
            <button
              type="button"
              className="btn--ghost btn--sm"
              onClick={() => {
                setDraft('');
                apply({ q: '' });
              }}
            >
              Сбросить
            </button>
          ) : null}
          <span className="small muted">{SEARCH_HINT[field]}</span>
        </form>

        <div className="toolbar">
          <select
            aria-label="Роль"
            data-filter-role
            value={role}
            onChange={(event) => apply({ role: event.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="">все роли</option>
            {Object.entries(ROLE_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Состояние аккаунта"
            data-filter-status
            value={status}
            onChange={(event) => apply({ status: event.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="">любое состояние</option>
            {Object.entries(STATUS_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Проверка личности"
            data-filter-kyc
            value={kyc}
            onChange={(event) => apply({ kyc: event.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="">любая проверка</option>
            {Object.entries(KYC_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Происхождение записи"
            data-filter-origin
            value={origin}
            onChange={(event) => apply({ origin: event.target.value })}
            style={{ width: 'auto' }}
          >
            <option value="real">без записей проверок</option>
            <option value="probes">только записи проверок</option>
            <option value="all">все записи</option>
          </select>
          <span className="small muted" data-users-total>
            {busy ? 'Считаем…' : `Найдено: ${total}`}
          </span>
        </div>
      </div>

      {error ? <div className="alert alert--error">{error}</div> : null}

      <div className="card">
        {busy && !page ? (
          <div className="spinner">Загружаем список…</div>
        ) : total === 0 ? (
          <div className="empty" data-users-empty>
            {q ? 'Никого не нашлось. Проверьте поле поиска и запрос.' : 'Пока никого нет.'}
          </div>
        ) : (
          <table data-users-table>
            <thead>
              <tr>
                <SortableHead
                  column="display_name"
                  sort={sort}
                  dir={dir}
                  onSort={sortBy}
                  label="Человек"
                />
                <th>Почта</th>
                <th>Телефон</th>
                <th>Роли</th>
                <SortableHead
                  column="status"
                  sort={sort}
                  dir={dir}
                  onSort={sortBy}
                  label="Состояние"
                />
                <th>Личность</th>
                <th>Откуда</th>
                <SortableHead
                  column="created_at"
                  sort={sort}
                  dir={dir}
                  onSort={sortBy}
                  label="Регистрация"
                />
                {/*
                  Столбец действия центрируется ЦЕЛИКОМ, а не поэлементно.
                  Иначе кнопка прижата влево, а заглушка «N/A» центрирована по
                  ячейке — и они стоят на разных линиях, что и бросается в
                  глаза в списке из двадцати строк.
                */}
                <th style={{ textAlign: 'center' }} />
              </tr>
            </thead>
            <tbody>
              {page?.items.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pages > 1 ? (
        <div className="toolbar" data-users-pager>
          <button
            type="button"
            className="btn--ghost btn--sm"
            disabled={current <= 1 || busy}
            onClick={() => apply({ page: String(current - 1) })}
          >
            Назад
          </button>
          <span className="small muted">
            Страница {current} из {pages}
          </span>
          <button
            type="button"
            className="btn--ghost btn--sm"
            data-page-next
            disabled={current >= pages || busy}
            onClick={() => apply({ page: String(current + 1) })}
          >
            Вперёд
          </button>
        </div>
      ) : null}
    </div>
  );
}

function UserRow({ user }: { user: AdminUserRow }) {
  return (
    <tr data-user-row={user.id}>
      {/*
        Имя держится В ОДНУ СТРОКУ, а длинное — обрезается многоточием.
        Иначе высота строки зависит от длины имени: после появления столбца
        с кабинетом столбец имени сузился, имена вроде «Сотрудник admin
        72184153» стали переноситься, и весь список вырос с 40 до 53
        пикселей — то есть потерял плотность, ради которой его и делали.
        Полное имя остаётся в подсказке и в карточке.
      */}
      <td style={{ maxWidth: 260 }}>
        <Link
          to={`/users/${user.id}`}
          data-user-link
          title={user.displayName}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 10, maxWidth: '100%' }}
        >
          <Avatar user={user} size={24} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.displayName}
          </span>
        </Link>
      </td>
      <td className="small">{user.emailMasked ?? <span className="muted">—</span>}</td>
      <td className="small">{user.phoneMasked ?? <span className="muted">—</span>}</td>
      <td className="small">
        {user.roles.length > 0 ? (
          user.roles.map((role) => ROLE_LABEL[role] ?? role).join(', ')
        ) : (
          <span className="muted">без ролей</span>
        )}
      </td>
      <td>
        <span className={`badge badge--${statusTone(user.status)}`}>
          {STATUS_LABEL[user.status] ?? user.status}
        </span>
      </td>
      <td className="small">{KYC_LABEL[user.kycStatus] ?? user.kycStatus}</td>
      <td className="small">
        {PROBE_ORIGIN.has(user.origin) ? (
          <span className="badge badge--muted">{ORIGIN_LABEL[user.origin] ?? user.origin}</span>
        ) : (
          <span className="muted">{ORIGIN_LABEL[user.origin] ?? user.origin}</span>
        )}
      </td>
      <td className="small num">{new Date(user.createdAt).toLocaleDateString('ru-RU')}</td>
      <td className="small" style={{ textAlign: 'center' }}>
        <ViewCabinetAction userId={user.id} roles={user.roles} compact />
      </td>
    </tr>
  );
}

/** Заголовок столбца, по которому можно сортировать. Направление видно стрелкой. */
function SortableHead({
  column,
  sort,
  dir,
  onSort,
  label,
}: {
  column: string;
  sort: string;
  dir: string;
  onSort: (column: string) => void;
  label: string;
}) {
  const active = sort === column;
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className="btn--ghost btn--sm"
        data-sort={column}
        onClick={() => onSort(column)}
        style={{ border: 'none', padding: 0, background: 'none', font: 'inherit' }}
      >
        {label}
        {active ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  );
}

const SEARCH_PLACEHOLDER: Record<string, string> = {
  name: 'Например, Соколова',
  email: 'Полный адрес целиком',
  phone: 'Полный номер в формате +7…',
  id: '019f…',
};

/**
 * Подсказка обязана быть честной: по контактам поиск ТОЛЬКО точный, потому
 * что адрес и телефон хранятся зашифрованными. Без этой строки человек решит,
 * что «не найдено» означает «нет такого».
 */
const SEARCH_HINT: Record<string, string> = {
  name: 'Ищем по части имени.',
  email: 'Адрес хранится зашифрованным — ищем по полному совпадению.',
  phone: 'Номер хранится зашифрованным — ищем по полному совпадению.',
  id: 'Точное совпадение идентификатора.',
};
