import { ApiError } from '../api';

/** Деньги приходят строкой и строкой же остаются: округлять их в UI нечем и незачем. */
export function formatMoney(amount: string | null): string {
  if (amount === null) return '—';
  const [whole = '0', fraction = '00'] = amount.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return fraction === '00' ? `${grouped} ₽` : `${grouped},${fraction} ₽`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Текст ошибки для пользователя.
 *
 * Берётся `detail` из problem+json — сервер уже позаботился о том, чтобы там не
 * было внутренних деталей. Своих формулировок про «ошибку 500» не добавляем:
 * они ничего не объясняют и выглядят как поломка.
 */
export function problemText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const detail = error.problem?.detail;
    const fields = error.problem?.errors?.map((e) => `${e.path}: ${e.message}`).join('; ');
    if (detail && fields) return `${detail} (${fields})`;
    if (detail) return detail;
    if (error.status === 0) return 'Сервер недоступен';
  }
  return fallback;
}
