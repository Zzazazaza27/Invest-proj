import type { AdminUserCard, AdminUserRow } from '@unicorn/contracts';

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
