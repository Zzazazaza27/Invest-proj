import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ProviderNotificationSchema,
  type PaymentMode,
  type ProviderNotification,
} from '@unicorn/contracts';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';

/**
 * Точка подключения оператора онлайн-платежей — ОДНА на весь продукт.
 *
 * Провайдер и получатель ещё не выбраны (решение владельца: предполагается
 * ИП, конфигурация не утверждена). Поэтому здесь описан интерфейс, которому
 * обязан соответствовать любой будущий адаптер, и единственная реализация —
 * тестовая. Ни одного имени конкретного сервиса модель не знает, и знать не
 * должна: когда провайдера выберут, появится второй файл рядом с этим, а
 * вызывающий код не изменится.
 *
 * Что обязан уметь адаптер — ровно то, без чего оплата небезопасна:
 *
 *  1. создать платёж на сумму, которую назвал СЕРВЕР (не клиент);
 *  2. вернуть идентификатор платежа на своей стороне;
 *  3. дать проверяемое подтверждение — подписанное уведомление, а не факт
 *     возвращения пользователя на страницу;
 *  4. сообщать неуспех и отмену так же внятно, как успех.
 *
 * Защита от повторной обработки живёт не здесь, а в данных: `eventId` каждого
 * уведомления уникален в `billing.payment_events` (M108).
 */
export interface PaymentProviderPort {
  /** Код адаптера; попадает в `billing.payments.provider`. */
  readonly code: string;
  /** Режим записывается в платёж и потом не меняется. */
  readonly mode: PaymentMode;
  /** Есть ли чем проверить подпись уведомления. Нет — уведомления отвергаются. */
  readonly notificationsVerifiable: boolean;

  /**
   * Создать платёж у оператора.
   *
   * `amountMinor` — целое число в копейках: денег с плавающей точкой в этом
   * коде нет. `paymentId` наш, он служит ключом сопоставления.
   */
  createPayment(input: {
    paymentId: string;
    amountMinor: bigint;
    currency: string;
    description: string;
    returnUrl?: string;
  }): Promise<{ providerRef: string; redirectUrl: string | null }>;

  /**
   * Разобрать и ПРОВЕРИТЬ уведомление.
   *
   * Обязан бросить, если подпись не сходится: неподписанное уведомление — это
   * сообщение от неизвестного, а не подтверждение оплаты.
   *
   * Тело приходит уже разобранным. Если будущий провайдер потребует проверки
   * подписи по СЫРЫМ байтам (так делают многие), в этом месте понадобится
   * сохранять исходную строку тела — отдельным парсером содержимого в
   * `main.ts`. Сейчас это не нужно и потому не сделано: лишний глобальный
   * разбор тела ради несуществующей интеграции — плохой размен.
   */
  parseNotification(
    body: unknown,
    headers: Record<string, string | undefined>,
  ): ProviderNotification;
}

/**
 * Тестовый адаптер: проходит весь путь, не двигая ни рубля.
 *
 * Он нужен, чтобы сценарий оплаты был проверяем до выбора провайдера — и
 * чтобы проверялся именно тот путь, который потом пойдёт в бой: создание
 * платежа на серверную сумму, подписанное уведомление, идемпотентность.
 *
 * Подпись настоящая (HMAC-SHA256 с ключом из окружения) и сравнивается
 * постоянным по времени сравнением — как в уже работающем Integration API.
 * Поддельное уведомление не пройдёт даже здесь: тестовый режим не означает
 * «пускать кого угодно».
 */
export class TestPaymentProvider implements PaymentProviderPort {
  readonly code = 'test';
  readonly mode: PaymentMode = 'test';

  constructor(private readonly secret: string) {}

  get notificationsVerifiable(): boolean {
    return this.secret.length >= MIN_SECRET_LENGTH;
  }

  async createPayment(input: {
    paymentId: string;
    amountMinor: bigint;
    currency: string;
    description: string;
    returnUrl?: string;
  }): Promise<{ providerRef: string; redirectUrl: string | null }> {
    // Настоящий адаптер сходил бы в сеть; тестовый выдаёт ссылку на себя же.
    // Важно другое: страница оплаты — это НЕ подтверждение. Подтверждением
    // будет отдельное уведомление, и только оно.
    const providerRef = `test_${randomUUID()}`;
    const back = input.returnUrl ? `?return=${encodeURIComponent(input.returnUrl)}` : '';
    return {
      providerRef,
      redirectUrl: `${getEnv().CORE_PUBLIC_URL}/v1/billing/payments/test-checkout/${providerRef}${back}`,
    };
  }

  parseNotification(
    body: unknown,
    headers: Record<string, string | undefined>,
  ): ProviderNotification {
    if (!this.notificationsVerifiable) {
      throw errors.featureDisabled('payments.webhook_secret');
    }
    // Сперва разбор, потом подпись: подписывать нечего, пока неизвестно, что
    // пришло. На результат проверки содержимое при этом не влияет.
    const parsed = ProviderNotificationSchema.safeParse(body);
    if (!parsed.success) {
      throw errors.validation([
        { path: 'body', message: 'уведомление не содержит обязательных полей' },
      ]);
    }

    const provided = headers['x-payment-signature'];
    if (!provided) {
      throw errors.unauthenticated({ stage: 'payment-signature-missing' });
    }
    const expected = createHmac('sha256', this.secret)
      .update(canonicalPayload(parsed.data), 'utf8')
      .digest();
    let given: Buffer;
    try {
      given = Buffer.from(provided, 'hex');
    } catch {
      throw errors.unauthenticated({ stage: 'payment-signature-encoding' });
    }
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw errors.unauthenticated({ stage: 'payment-signature' });
    }
    return parsed.data;
  }
}

/**
 * Что именно подписано.
 *
 * Не «тело как пришло», а перечисленные поля в жёстком порядке: только они
 * влияют на решение об оплате, и подменить любое из них незаметно нельзя.
 * Порядок фиксирован здесь, а не выводится из объекта, — иначе подпись
 * зависела бы от порядка ключей в JSON.
 */
export function canonicalPayload(notification: ProviderNotification): string {
  return [
    notification.eventId,
    notification.eventType,
    notification.providerRef,
    notification.outcome,
    notification.amount ?? '',
    notification.currency ?? '',
  ].join('|');
}

const MIN_SECRET_LENGTH = 32;

/** Отпечаток тела уведомления — хранится рядом с самим уведомлением. */
export function payloadDigest(payload: string): Buffer {
  return createHash('sha256').update(payload, 'utf8').digest();
}

/**
 * Какой адаптер работает сейчас.
 *
 * Одно место выбора. Когда провайдера выберут, здесь появится ветка — и
 * больше нигде: сервис платежей знает только интерфейс.
 */
export function resolveProvider(): PaymentProviderPort {
  const env = getEnv();
  switch (env.PAYMENTS_PROVIDER) {
    case 'test':
      return new TestPaymentProvider(env.PAYMENTS_WEBHOOK_SECRET);
    default: {
      // Недостижимо по схеме окружения, но пусть отказ будет явным: неизвестный
      // провайдер денег принимать не должен.
      throw errors.featureDisabled('payments.provider');
    }
  }
}
