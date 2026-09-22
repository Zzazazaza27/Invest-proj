import { useState } from 'react';
import type { AdminUserCard, AdminUserRow } from '@unicorn/contracts';
import { api } from '../api';

/**
 * Общие подписи и мелочи раздела «Пользователи».
 *
 * Вынесены в отдельный файл, потому что список и карточка обязаны называть
 * одно и то же одинаково: «заблокирован» в таблице и «приостановлен» в
 * карточке — это два разных слова про одно состояние, и человек начинает
 * искать разницу там, где её нет.
 */

export const ROLE_LABEL: Record<string, string> = {
  founder: 'основатель',
  investor: 'инвестор',
  expert: 'эксперт',
  organizer: 'организатор',
  admin: 'администратор',
  corporate: 'корпорация',
  showrunner: 'шоураннер',
};

export const STATUS_LABEL: Record<string, string> = {
  pending_consents: 'ждёт акцептов',
  active: 'активен',
  suspended: 'заблокирован',
  deleted: 'удалён',
};

export const KYC_LABEL: Record<string, string> = {
  none: 'не начата',
  pending: 'подана',
  in_review: 'на проверке',
  verification_pending: 'ждёт подтверждения',
  approved: 'подтверждена',
  rejected: 'отклонена',
};

/**
 * Откуда взялась запись (M127).
 *
 * Подписи короткие намеренно: это столбец в плотной таблице, а не пояснение.
 * «Сам» вместо «самостоятельная регистрация» читается с одного взгляда, а
 * подробности человеку тут не нужны — ему нужно отличить живого от следа
 * прогона.
 */
export const ORIGIN_LABEL: Record<string, string> = {
  self_registration: 'сам',
  invite: 'приглашение',
  seed_demo: 'демо-комплект',
  seed_acceptance: 'приёмка',
  staff_check: 'проверка сотрудника',
  render_check: 'браузерный прогон',
  load_test: 'нагрузочный прогон',
  test_session: 'тестовая сессия',
  unknown: 'неизвестно',
};

/**
 * Записи проверок: их список прячет по умолчанию и помечает в столбце.
 *
 * Уборку это НЕ задаёт: следы прогонов убирает `stand:clean-probes`,
 * участников тестовой сессии — уборка их сессии.
 */
export const PROBE_ORIGIN = new Set(['render_check', 'load_test', 'test_session']);

/** Цвет несёт подсказку, но не смысл: рядом всегда есть слово. */
export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'muted' {
  if (status === 'active') return 'ok';
  if (status === 'suspended') return 'danger';
  if (status === 'pending_consents') return 'warn';
  return 'muted';
}

/**
 * Аватар или его замена.
 *
 * Замена — не серый квадрат, а первая буква имени: в списке из двадцати
 * строк одинаковые заглушки не помогают отличить людей друг от друга.
 */
export function Avatar({
  user,
  size = 32,
}: {
  user: Pick<AdminUserRow, 'displayName' | 'avatarUrl'> | AdminUserCard;
  size?: number;
}) {
  const letter = user.displayName.trim().charAt(0).toUpperCase() || '?';
  const common: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    flexShrink: 0,
    objectFit: 'cover',
  };
  if (user.avatarUrl) {
    return <img src={user.avatarUrl} alt="" style={common} data-avatar />;
  }
  return (
    <span
      aria-hidden="true"
      data-avatar="letter"
      style={{
        ...common,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--u-accent-subtle)',
        color: 'var(--u-accent)',
        fontWeight: 700,
        fontSize: Math.round(size * 0.45),
      }}
    >
      {letter}
    </span>
  );
}

/**
 * Кабинеты, доступные человеку по его ролям.
 *
 * Выбор нужен потому, что ролей бывает несколько: у одного и того же человека
 * есть и кабинет основателя, и кабинет инвестора. «Посмотреть кабинет» без
 * выбора открывал бы первый попавшийся — и человек решил бы, что второго нет.
 */
export const CABINET_BY_ROLE: Record<string, { href: string; title: string }> = {
  founder: { href: '/lab/', title: 'кабинет основателя' },
  investor: { href: '/investor/', title: 'кабинет инвестора' },
  expert: { href: '/expert/', title: 'кабинет эксперта' },
  // Кабинет администратора — это НЕ админка, а его личное пространство как
  // обычного человека. Раньше действие вело в админку, то есть показывало
  // инструмент вместо человека; теперь у него свой адрес (пока с заглушкой).
  admin: { href: '/staff/', title: 'кабинет сотрудника' },
};

export function cabinetsOf(
  roles: readonly string[],
): { role: string; href: string; title: string }[] {
  const seen = new Set<string>();
  const result: { role: string; href: string; title: string }[] = [];
  for (const role of roles) {
    const cabinet = CABINET_BY_ROLE[role];
    if (!cabinet || seen.has(cabinet.href)) continue;
    seen.add(cabinet.href);
    result.push({ role, ...cabinet });
  }
  return result;
}

/**
 * «Посмотреть кабинет» — режим ДИАГНОСТИКИ рабочего аккаунта.
 *
 * Это не тестовая сессия: данные человека не помечаются тестовыми и под
 * уборку не попадают. Режим только для чтения, и запрет изменений держит
 * сервер, а не эта кнопка.
 *
 * Идентификатор контекста уезжает в ЯКОРЕ адреса: на сервер он не уходит и в
 * журналы доступа не попадает, а вкладка сразу переложит его в своё
 * состояние и вычистит адрес.
 */
export function ViewCabinetAction({
  userId,
  roles,
  compact = false,
}: {
  userId: string;
  roles: readonly string[];
  compact?: boolean;
}) {
  const cabinets = cabinetsOf(roles);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (href: string) => {
    setBusy(true);
    setError(null);
    try {
      const { contextId } = await api.testing.openUserView(userId);
      window.open(`${href}#ctx=${contextId}`, '_blank', 'noopener');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'не удалось открыть');
    } finally {
      setBusy(false);
    }
  };

  if (cabinets.length === 0) {
    /*
     * Пустая ячейка читается как «кнопку забыли», и вопрос «почему не у
     * всех?» задают первым делом. Кабинет есть у основателя, инвестора и
     * эксперта; у организатора и администратора отдельного кабинета нет —
     * их рабочее место сама админка. Поэтому вместо пустоты стоит прочерк
     * с объяснением: в этом столбце прочерк уже означает «нечего
     * показывать», как в столбцах почты и телефона.
     */
    const roleNames = roles.map((role) => ROLE_LABEL[role] ?? role).join(', ');
    return (
      <span
        className="muted small"
        data-view-cabinet="none"
        title={
          roles.length === 0
            ? 'У человека нет ролей — смотреть нечего'
            : // Не «работает в админке»: организатору там ничего не доступно,
              // пока сезоны отложены и роль вырезается из сессии. Честная
              // формулировка — просто «служебная роль, кабинета нет».
              `Своего кабинета нет: ${roleNames || 'роль'} — служебная роль`
        }
      >
        N/A
      </span>
    );
  }

  /**
   * В СТРОКЕ СПИСКА действие обязано быть одной короткой кнопкой.
   *
   * Первая версия рисовала по кнопке на кабинет с полными подписями — и
   * строка таблицы выросла с 40 до 59 пикселей, то есть откатила плотность
   * админки, ради которой её и уплотняли. Когда кабинетов несколько, выбор
   * даёт обычный список: он занимает ту же строку.
   */
  const only = cabinets.length === 1 ? cabinets[0] : null;
  if (compact) {
    if (only) {
      return (
        <button
          type="button"
          className="btn--ghost btn--sm"
          data-view-cabinet={only.role}
          disabled={busy}
          onClick={() => void open(only.href)}
          title={`Открыть ${only.title} только для чтения`}
        >
          Кабинет
        </button>
      );
    }
    return (
      <select
        aria-label="Посмотреть кабинет"
        data-view-cabinet="choose"
        disabled={busy}
        value=""
        onChange={(event) => {
          const href = event.target.value;
          event.target.value = '';
          if (href) void open(href);
        }}
        style={{ width: 'auto' }}
      >
        <option value="">Кабинет…</option>
        {cabinets.map((cabinet) => (
          <option key={cabinet.href} value={cabinet.href}>
            {cabinet.title.replace('кабинет ', '')}
          </option>
        ))}
      </select>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {cabinets.map((cabinet) => (
        <button
          key={cabinet.href}
          type="button"
          className="btn--ghost btn--sm"
          data-view-cabinet={cabinet.role}
          disabled={busy}
          onClick={() => void open(cabinet.href)}
          title={`Открыть ${cabinet.title} только для чтения`}
        >
          {`Посмотреть ${cabinet.title}`}
        </button>
      ))}
      {error ? (
        <span
          className="small"
          data-view-cabinet-error
          style={{ color: 'var(--u-danger, #b42318)' }}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
