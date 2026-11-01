import { useEffect, useRef, useState } from 'react';
import type { AdminUserCard, AdminUserRow } from '@unicorn/contracts';
import { Button } from '@unicorn/ui';
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
  admin: 'администратор',
  corporate: 'корпорация',
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
  monitoring: 'служебная: мониторинг',
  unknown: 'неизвестно',
};

/**
 * Записи проверок: их список прячет по умолчанию и помечает в столбце.
 *
 * Уборку это НЕ задаёт: следы прогонов убирает `stand:clean-probes`,
 * участников тестовой сессии — уборка их сессии.
 */
export const PROBE_ORIGIN = new Set(['render_check', 'load_test', 'test_session', 'monitoring']);

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
  raised = false,
}: {
  user: Pick<AdminUserRow, 'displayName' | 'avatarUrl'> | AdminUserCard;
  size?: number;
  /** На цветном фоне (шапка карточки) — белая подложка с рамкой, иначе буква сливается. */
  raised?: boolean;
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
        background: raised ? 'var(--u-surface)' : 'var(--u-accent-subtle)',
        boxShadow: raised ? 'inset 0 0 0 1px var(--border)' : undefined,
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
  // Кабинет эксперта и кабинет сотрудника удалены в 2.1-W05: у администратора
  // нет личного кабинета, кроме самой админки.
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

/** Где у экрана стоит меню кабинетов: под кнопкой (`top`) или над ней (`bottom`). */
type MenuPosition = { right: number; minWidth: number; top?: number; bottom?: number };

/**
 * Одна ширина и одна строка для кнопки кабинета в списке — с меню и без.
 * Иначе столбец «ехал» от числа ролей: стрелка переносилась, строка росла.
 */
const CABINET_BUTTON_STYLE: React.CSSProperties = { minWidth: '7.5em', whiteSpace: 'nowrap' };

/**
 * Куда вернуть вкладку просмотра, если браузер не даст её закрыть: страница
 * админки, с которой просмотр открыли (`#…&back=…`). Кабинет принимает только
 * пути внутри `/admin/`.
 */
export function backHere(): string {
  return encodeURIComponent(window.location.pathname);
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
 * состояние и вычистит адрес. «Завершить просмотр» закрывает эту вкладку.
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
  const [menuAt, setMenuAt] = useState<MenuPosition | null>(null);
  const menuOpen = menuAt !== null;
  const setMenuOpen = (value: boolean) => {
    if (!value) setMenuAt(null);
  };
  const menuRef = useRef<HTMLSpanElement>(null);

  /*
   * Меню стоит поверх страницы (`position: fixed`) у кнопки, а не внутри
   * таблицы. Внутри таблицы оно растягивало её прокручиваемый блок, и у
   * нижних строк появлялась лишняя прокрутка. Места снизу не хватает —
   * открывается вверх.
   */
  const toggleMenu = (button: HTMLElement) => {
    if (menuAt) {
      setMenuAt(null);
      return;
    }
    const rect = button.getBoundingClientRect();
    const estimated = cabinets.length * 34 + 12;
    const right = window.innerWidth - rect.right;
    const minWidth = rect.width;
    setMenuAt(
      window.innerHeight - rect.bottom < estimated + 8
        ? { right, minWidth, bottom: window.innerHeight - rect.top + 4 }
        : { right, minWidth, top: rect.bottom + 4 },
    );
  };

  // Меню закрывается щелчком мимо, Escape, прокруткой и сменой размера окна:
  // прикреплённое к экрану, оно иначе отстало бы от своей кнопки.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    const close = () => setMenuOpen(false);
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuOpen]);

  const open = async (href: string) => {
    setBusy(true);
    setError(null);
    try {
      const { contextId } = await api.testing.openUserView(userId);
      window.open(`${href}#ctx=${contextId}&back=${backHere()}`, '_blank', 'noopener');
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'не удалось открыть');
    } finally {
      setBusy(false);
    }
  };

  if (cabinets.length === 0) {
    /*
     * Пустая ячейка читается как «кнопку забыли», и вопрос «почему не у
     * всех?» задают первым делом. Кабинет есть у основателя и инвестора;
     * у администратора отдельного кабинета нет — его рабочее место сама
     * админка. Поэтому вместо пустоты стоит прочерк
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
            : `Своего кабинета нет: ${roleNames || 'роль'} — служебная роль`
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
        <Button
          type="button"
          variant="quiet"
          size="sm"
          data-view-cabinet={only.role}
          style={CABINET_BUTTON_STYLE}
          disabled={busy}
          onClick={() => void open(only.href)}
          title={`Открыть ${only.title} только для чтения`}
        >
          Кабинет
        </Button>
      );
    }
    // Кнопка та же, что при одной роли, — столбец не «едет» от числа ролей.
    // Раньше здесь стоял select шире кнопки, и строки с несколькими ролями
    // выглядели иначе. Выбор кабинета — меню под кнопкой.
    return (
      <span ref={menuRef} style={{ position: 'relative', display: 'inline-block' }}>
        <Button
          type="button"
          variant="quiet"
          size="sm"
          data-view-cabinet-menu
          style={CABINET_BUTTON_STYLE}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          onClick={(event) => toggleMenu(event.currentTarget)}
          title="Выбрать кабинет для просмотра только для чтения"
        >
          Кабинет ▾
        </Button>
        {menuAt ? (
          <span
            role="menu"
            style={{
              position: 'fixed',
              ...menuAt,
              zIndex: 50,
              display: 'flex',
              flexDirection: 'column',
              padding: 4,
              background: 'var(--u-surface)',
              border: '1px solid var(--u-border)',
              borderRadius: 'var(--u-radius-md)',
              boxShadow: 'var(--u-shadow-md)',
            }}
          >
            {cabinets.map((cabinet) => (
              <button
                key={cabinet.href}
                type="button"
                role="menuitem"
                className="btn--ghost btn--sm"
                data-view-cabinet={cabinet.role}
                style={{ justifyContent: 'flex-start', whiteSpace: 'nowrap' }}
                onClick={() => {
                  setMenuOpen(false);
                  void open(cabinet.href);
                }}
              >
                {cabinet.title.charAt(0).toUpperCase() + cabinet.title.slice(1)}
              </button>
            ))}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {cabinets.map((cabinet) => (
        <Button
          key={cabinet.href}
          type="button"
          variant="quiet"
          size="sm"
          data-view-cabinet={cabinet.role}
          disabled={busy}
          onClick={() => void open(cabinet.href)}
          title={`Открыть ${cabinet.title} только для чтения`}
        >
          {`Посмотреть ${cabinet.title}`}
        </Button>
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
