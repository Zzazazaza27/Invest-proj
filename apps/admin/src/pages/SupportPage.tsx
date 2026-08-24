import { SupportCard, type SupportPort } from '@unicorn/cabinet';
import type { SupportTicketStatus } from '@unicorn/contracts';
import { api } from '../api';

/**
 * Поддержка глазами сотрудника.
 *
 * Экран — тот же общий компонент, что и в кабинетах пользователей: расходиться
 * им незачем, разговор один и тот же с двух сторон. Отличается только флаг
 * `staff`: он включает кнопки «взять в работу» и «закрыть».
 *
 * Флаг НЕ решает, чьи обращения видны. Список приходит по политике БД —
 * сотруднику все, пользователю свои. Решай видимость этот флаг, доступ к
 * чужим обращениям зависел бы от значения переменной в браузере.
 */
const port: SupportPort = {
  list: () => api.supportTickets(),
  detail: (id) => api.supportTicket(id),
  open: (input) => api.openSupportTicket({ kind: 'support', ...input }),
  reply: (id, body) => api.replySupportTicket(id, body),
  update: (id, input: { status?: SupportTicketStatus; assignToMe?: boolean }) =>
    api.updateSupportTicket(id, input),
};

export function SupportPage() {
  return <SupportCard port={port} staff />;
}
