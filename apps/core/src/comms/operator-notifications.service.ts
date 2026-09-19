import { Injectable } from '@nestjs/common';
import { uuidv7, type ServiceCountryPolicy } from '@unicorn/contracts';
import { getEnv } from '../config/env';
import { AuditRepository } from '../audit/audit.repository';
import type { RequestContext, Tx } from '../db/unit-of-work';

/**
 * Уведомления команде по порогу суммы раунда (5.9.5; таблица M102).
 *
 * Настройка `operator.notify` в условиях страны хранилась с 5.6, но ничем не
 * читалась. Здесь она наконец исполняется — и ровно в своих границах.
 *
 * Порог ТОЛЬКО уведомляет. Он не меняет вознаграждение, не открывает и не
 * закрывает доступ и не делает участие оператора обязательным:
 * `manualReviewRequired` — отдельная настройка, и «мы заметили крупный раунд»
 * не то же самое, что «раунд не открывается без человека».
 *
 * Отсюда же правило обработки ошибок: неудача уведомления НЕ отменяет
 * открытие раунда. Иначе порог начал бы влиять на доступ — ровно то, чего
 * делать нельзя.
 *
 * Внешняя рассылка выключена: транспорт записывается в саму запись, и при
 * `none` наружу ничего не уходит. Утверждать «отправлено», когда письма нет,
 * нельзя.
 */
@Injectable()
export class OperatorNotificationsService {
  constructor(private readonly audit: AuditRepository) {}

  /**
   * Зафиксировать уведомление об открытии крупного раунда.
   *
   * Возвращает `true`, если запись создана. Повторная обработка того же
   * события второй записи не создаёт: ключ события уникален.
   */
  async notifyRoundOpened(
    tx: Tx,
    ctx: RequestContext,
    input: {
      roundId: string;
      projectId: string;
      countryCode: string;
      policy: { version: number; config: ServiceCountryPolicy };
      target: string | null;
      currency: string;
    },
  ): Promise<boolean> {
    const notify = input.policy.config.operator.notify;
    if (!notify.enabled || notify.minTarget === null || input.target === null) return false;
    if (Number(input.target) < Number(notify.minTarget)) return false;
    if (notify.recipients.length === 0) return false;

    const eventKey = `round_opened:${input.roundId}`;

    // Точка сохранения, а не `ON CONFLICT`: уведомления читает только
    // администратор, а `ON CONFLICT` требует права ВИДЕТЬ конфликтующую
    // строку — то есть открыть чужую внутреннюю переписку тому, кто просто
    // открывает раунд. Повтор ловим по уникальному ключу, а откат точки
    // сохранения оставляет транзакцию открытия живой.
    await tx.query('SAVEPOINT operator_notification');
    try {
      await tx.query(
        `INSERT INTO comms.operator_notifications
           (id, event_key, kind, round_id, project_id, country_code, policy_version,
            target_amount, threshold, currency, recipients, delivery_mode)
         VALUES ($1, $2, 'round_opened_over_threshold', $3, $4, $5, $6,
                 $7::numeric, $8::numeric, $9, $10, $11)`,
        [
          uuidv7(),
          eventKey,
          input.roundId,
          input.projectId,
          input.countryCode,
          input.policy.version,
          input.target,
          notify.minTarget,
          input.currency,
          notify.recipients,
          deliveryMode(),
        ],
      );
      await tx.query('RELEASE SAVEPOINT operator_notification');
    } catch (error) {
      await tx.query('ROLLBACK TO SAVEPOINT operator_notification');
      // Повторная обработка того же события — норма, а не сбой.
      if ((error as { code?: string }).code === '23505') return false;
      // Любая другая беда с уведомлением тоже НЕ отменяет открытие раунда:
      // иначе настройка уведомлений начала бы решать, кому привлекать деньги.
      return false;
    }

    await this.audit.emit(tx, {
      verb: 'comms.operator_notification.recorded',
      actorId: ctx.userId,
      actorRole: 'system',
      subjectType: 'funding_round',
      subjectId: input.roundId,
      context: {
        target: input.target,
        threshold: notify.minTarget,
        recipients: notify.recipients.length,
        deliveryMode: deliveryMode(),
      },
      traceId: ctx.traceId,
    });
    return true;
  }
}

/**
 * Транспорт, которым уведомление ушло бы наружу.
 *
 * Локально и на проверках это `none`: запись о событии есть, письма нет.
 * Значение хранится вместе с записью, чтобы потом не гадать, дошло ли
 * уведомление до людей.
 */
function deliveryMode(): 'none' | 'file' | 'smtp' {
  const mode = getEnv().MAIL_TRANSPORT;
  return mode === 'smtp' ? 'smtp' : mode === 'file' ? 'file' : 'none';
}
