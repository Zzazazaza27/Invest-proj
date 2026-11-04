import { Injectable, Logger } from '@nestjs/common';
import {
  uuidv7,
  type BugContext,
  type SupportMessage,
  type SupportTicket,
  type SupportTicketDetail,
  type SupportTicketKind,
  type SupportTicketStatus,
} from '@fifth/contracts';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { MailTransport } from './mail.transport';

/**
 * Поддержка пользователей и сообщения об ошибках.
 *
 * Два механизма, о которых говорит задача, соединены здесь:
 *
 *  1. обращение живёт В СИСТЕМЕ — человек видит свою историю и переписку;
 *  2. копия уходит на служебный ящик проекта — потому что исходить из того,
 *     что оператор сидит в интерфейсе круглосуточно, нельзя.
 *
 * Порядок между ними принципиален: сначала фиксируется обращение, потом
 * отправляется письмо. Обратный порядок означал бы, что при падении на записи
 * человек получил подтверждение приёма, а обращения нет ни у кого.
 *
 * И письмо НЕ отменяет обращение: если почтовый канал не настроен или упал,
 * обращение всё равно сохранено и видно в интерфейсе поддержки. Отказывать
 * человеку в приёме жалобы из-за неработающей почты — ровно та ошибка, от
 * которой второй механизм и страхует.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly db: Database,
    private readonly mail: MailTransport,
  ) {}

  // ------------------------------------------------------------- создание

  /**
   * Новое обращение вместе с первым сообщением.
   *
   * Технический контекст собирается ЗДЕСЬ, а не берётся из тела запроса
   * целиком: часть полей клиент прислать не вправе (роль, идентификатор,
   * момент), а часть — не может знать честно. Что именно принимается от
   * клиента, описано в `BugContextSchema`; всё остальное — из контекста
   * запроса.
   */
  async open(
    ctx: RequestContext,
    input: {
      kind: SupportTicketKind;
      subject: string;
      body: string;
      context?: BugContext;
      /** Заголовок `User-Agent` запроса. Берётся из запроса, а не из тела. */
      userAgent?: string;
    },
  ): Promise<SupportTicketDetail> {
    if (!ctx.userId) throw errors.unauthenticated();

    const context =
      input.kind === 'bug_report'
        ? {
            ...(input.context ?? {}),
            // Момент фиксирует сервер: часы браузера бывают сдвинуты на часы и
            // дни, и по такому времени событие в журнале не найти.
            occurredAt: new Date().toISOString(),
            // Роль — из проверенного контекста, а не из утверждения клиента.
            roles: [...ctx.roles],
            // Сквозной идентификатор запроса: по нему обращение соединяется с
            // журналом сервера. Именно то, что человеку не надо переписывать
            // руками.
            traceId: ctx.traceId,
            userAgent: (input.userAgent ?? '').slice(0, 400) || undefined,
          }
        : {};

    const ticket = await this.db.transaction(ctx, async (tx) => {
      const ticketId = uuidv7();
      const { rows } = await tx.query<TicketRow>(
        `INSERT INTO comms.support_tickets (id, user_id, kind, subject, context_jsonb)
              VALUES ($1, $2, $3, $4, $5::jsonb)
           RETURNING id, kind, subject, status, context_jsonb, assigned_to,
                     created_at, closed_at`,
        [ticketId, ctx.userId, input.kind, input.subject, JSON.stringify(context)],
      );
      await tx.query(
        `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
              VALUES ($1, $2, $3, 'user', $4)`,
        [uuidv7(), ticketId, ctx.userId, input.body],
      );
      return rows[0]!;
    });

    await this.notifyInbox({
      kind: input.kind,
      ticketId: ticket.id,
      subject: input.subject,
      body: input.body,
      context,
      isFirstMessage: true,
    });

    return this.detail(ctx, ticket.id);
  }

  // ------------------------------------------------------------- переписка

  /**
   * Сообщение в существующее обращение.
   *
   * Кто пишет — решает роль в контексте, а не поле запроса. Сотрудник в чужом
   * обращении пишет как `staff`, в своём собственном — как `user`: иначе
   * администратор, обратившийся в поддержку сам, отвечал бы себе от лица
   * поддержки.
   */
  async reply(ctx: RequestContext, ticketId: string, body: string): Promise<SupportMessage> {
    if (!ctx.userId) throw errors.unauthenticated();

    const message = await this.db.transaction(ctx, async (tx) => {
      const ticket = await this.loadTicketRow(tx, ticketId);
      const isOwner = ticket.user_id === ctx.userId;
      const authorKind = isOwner ? 'user' : 'staff';

      if (ticket.status === 'closed') {
        throw errors.stateTransition('Обращение закрыто — откройте новое');
      }

      const { rows } = await tx.query<MessageRow>(
        `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
              VALUES ($1, $2, $3, $4, $5)
           RETURNING id, author_kind, body, created_at`,
        [uuidv7(), ticketId, ctx.userId, authorKind, body],
      );
      return { row: rows[0]!, authorKind, subject: ticket.subject, kind: ticket.kind };
    });

    // На служебный ящик уходит только сообщение ПОЛЬЗОВАТЕЛЯ: ответ сотрудника
    // отправлять самим себе бессмысленно, а ящик от этого становится нечитаемым.
    if (message.authorKind === 'user') {
      await this.notifyInbox({
        kind: message.kind,
        ticketId,
        subject: message.subject,
        body,
        context: {},
        isFirstMessage: false,
      });
    }

    return mapMessage(message.row);
  }

  // -------------------------------------------------------------- чтение

  /**
   * Список обращений.
   *
   * Никакого параметра «чей список» нет и быть не должно: границу задаёт
   * политика RLS — свои строки видит автор, все строки видит сотрудник
   * поддержки. Параметр запроса здесь означал бы, что доступ к чужим
   * обращениям решается на стороне клиента.
   */
  async list(ctx: RequestContext, limit: number): Promise<SupportTicket[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<TicketRow & AggRow>(
        `SELECT t.id, t.kind, t.subject, t.status, t.context_jsonb, t.assigned_to,
                t.created_at, t.closed_at,
                m.last_message_at, COALESCE(m.message_count, 0) AS message_count
           FROM comms.support_tickets t
           LEFT JOIN LATERAL (
                SELECT max(created_at) AS last_message_at, count(*) AS message_count
                  FROM comms.support_messages
                 WHERE ticket_id = t.id
           ) m ON true
          ORDER BY COALESCE(m.last_message_at, t.created_at) DESC
          LIMIT $1`,
        [limit],
      );
      return rows.map(mapTicket);
    });
  }

  async detail(ctx: RequestContext, ticketId: string): Promise<SupportTicketDetail> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<TicketRow & AggRow>(
        `SELECT t.id, t.kind, t.subject, t.status, t.context_jsonb, t.assigned_to,
                t.created_at, t.closed_at,
                m.last_message_at, COALESCE(m.message_count, 0) AS message_count
           FROM comms.support_tickets t
           LEFT JOIN LATERAL (
                SELECT max(created_at) AS last_message_at, count(*) AS message_count
                  FROM comms.support_messages
                 WHERE ticket_id = t.id
           ) m ON true
          WHERE t.id = $1`,
        [ticketId],
      );
      // Чужое обращение не найдено политикой — и ответ такой же, как для
      // несуществующего. Различать эти два случая значило бы подтверждать
      // существование чужих обращений перебором идентификаторов.
      if (rows.length === 0) throw errors.notFound({ ticketId });

      const messages = await tx.query<MessageRow>(
        `SELECT id, author_kind, body, created_at
           FROM comms.support_messages
          WHERE ticket_id = $1
          ORDER BY created_at`,
        [ticketId],
      );

      return {
        ...mapTicket(rows[0]!),
        context: (rows[0]!.context_jsonb ?? {}) as Record<string, unknown>,
        messages: messages.rows.map(mapMessage),
      };
    });
  }

  // ------------------------------------------------------- работа сотрудника

  /**
   * Смена состояния рассмотрения и взятие в работу.
   *
   * Право проверяет БД: политика `support_tickets_staff` пускает на UPDATE
   * только роль `admin`. Здесь остаётся то, чего политика выразить не может, —
   * порядок состояний и согласованность `closed_at` со `status`.
   */
  async update(
    ctx: RequestContext,
    ticketId: string,
    input: { status?: SupportTicketStatus; assignToMe?: boolean },
  ): Promise<SupportTicketDetail> {
    if (!ctx.userId) throw errors.unauthenticated();
    if (input.status === undefined && input.assignToMe === undefined) {
      throw errors.validation([{ path: '(корень)', message: 'нечего менять' }]);
    }
    // Возврат закрытого обращения в работу — не отказ, а осознанно
    // разрешённое действие: сотрудник ошибся кнопкой, и заставлять человека
    // заводить новое обращение из-за чужой ошибки неправильно.

    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE comms.support_tickets
            SET status      = COALESCE($2::text, status),
                closed_at   = CASE WHEN $2::text = 'closed' THEN COALESCE(closed_at, now())
                                   WHEN $2::text IS NULL    THEN closed_at
                                   ELSE NULL END,
                assigned_to = CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_to END
          WHERE id = $1`,
        [ticketId, input.status ?? null, input.assignToMe ?? false, ctx.userId],
      );
      // Ноль строк — это и «нет такого обращения», и «политика не пустила».
      // Наружу оба случая обязаны выглядеть одинаково.
      if (rowCount === 0) throw errors.notFound({ ticketId });
    });

    return this.detail(ctx, ticketId);
  }

  // ---------------------------------------------------------------- почта

  /**
   * Копия обращения на служебный ящик.
   *
   * Ошибка отправки НЕ роняет запрос: обращение уже сохранено, и человеку
   * незачем видеть отказ из-за почты. Но и молчать нельзя — неудача уходит в
   * лог предупреждением, иначе «письма не приходят» выяснялось бы через
   * неделю по жалобе.
   *
   * В письме нет ни одного секрета: тема, номер обращения и текст, который
   * человек написал сам. Ссылка на обращение собирается из PUBLIC_BASE_URL,
   * а не из заголовка Host.
   */
  private async notifyInbox(input: {
    kind: SupportTicketKind;
    ticketId: string;
    subject: string;
    body: string;
    context: Record<string, unknown>;
    isFirstMessage: boolean;
  }): Promise<void> {
    const env = getEnv();
    const inbox = env.SUPPORT_INBOX_EMAIL;
    if (!inbox || !this.mail.available) {
      this.logger.warn({
        msg: 'копия обращения на служебный ящик не отправлена — канал не настроен',
        ticketId: input.ticketId,
        hasInbox: Boolean(inbox),
        mailAvailable: this.mail.available,
      });
      return;
    }

    const label = input.kind === 'bug_report' ? 'Сообщение об ошибке' : 'Обращение в поддержку';
    const heading = input.isFirstMessage ? label : `${label} — новое сообщение`;
    const contextLines = Object.entries(input.context)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `  ${key}: ${String(value)}`);

    try {
      await this.mail.send({
        to: inbox,
        subject: `[${input.kind}] ${input.subject}`,
        text: [
          heading,
          '',
          `Обращение: ${input.ticketId}`,
          `Открыть: ${env.PUBLIC_BASE_URL}/admin/support/${input.ticketId}`,
          '',
          input.body,
          ...(contextLines.length > 0 ? ['', 'Технический контекст:', ...contextLines] : []),
          '',
        ].join('\n'),
      });
    } catch (error) {
      this.logger.warn({
        msg: 'копия обращения на служебный ящик не ушла',
        ticketId: input.ticketId,
        error,
      });
    }
  }

  /** Строка обращения под текущими правами. Ноль строк — «нет такого». */
  private async loadTicketRow(tx: Tx, ticketId: string): Promise<TicketOwnerRow> {
    const { rows } = await tx.query<TicketOwnerRow>(
      `SELECT id, user_id, kind, subject, status FROM comms.support_tickets WHERE id = $1`,
      [ticketId],
    );
    if (rows.length === 0) throw errors.notFound({ ticketId });
    return rows[0]!;
  }
}

interface TicketRow {
  id: string;
  kind: SupportTicketKind;
  subject: string;
  status: SupportTicketStatus;
  context_jsonb: Record<string, unknown> | null;
  assigned_to: string | null;
  created_at: Date;
  closed_at: Date | null;
}

interface AggRow {
  last_message_at: Date | null;
  message_count: string;
}

interface TicketOwnerRow {
  id: string;
  user_id: string;
  kind: SupportTicketKind;
  subject: string;
  status: SupportTicketStatus;
}

interface MessageRow {
  id: string;
  author_kind: 'user' | 'staff';
  body: string;
  created_at: Date;
}

function mapTicket(row: TicketRow & AggRow): SupportTicket {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    lastMessageAt: row.last_message_at ? row.last_message_at.toISOString() : null,
    messageCount: Number(row.message_count),
    // Наружу отдаётся ФАКТ назначения, а не исполнитель: имя сотрудника
    // поддержки автору обращения знать незачем.
    assigned: row.assigned_to !== null,
  };
}

function mapMessage(row: MessageRow): SupportMessage {
  return {
    id: row.id,
    authorKind: row.author_kind,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}
