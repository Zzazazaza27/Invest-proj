import { Breaker } from '../availability/rules';
import { isKmsUnavailable } from '../crypto/crypto.service';

/**
 * Здоровье группы «События и интеграции» (4.11). Два независимых контура:
 *
 *   * публикация outbox — брокер; размыкатель получает исходы публикации;
 *   * доставка вебхуков — исходящая сеть и получатели; пауза по получателю — в БД (M163),
 *     предполагаемый общий сбой — здесь, в экземпляре.
 *
 * Отказ одного контура другой не останавливает.
 */

// ------------------------------------------------------------- классификация отказа
/**
 * Чем кончилась неудачная доставка:
 *
 *   * `receiver` — ответил или отказал получатель: HTTP не 2xx, сертификат, имя не существует,
 *     адрес во внутренней сети. Сеть до него работает — в общий сигнал не входит;
 *   * `transport` — сеть до получателя: отказ соединения, сброс, таймаут до передачи тела,
 *     временный сбой DNS, нет маршрута. Входит в общий сигнал — как предположение, не
 *     доказательство: маршрута может не быть только к одной сети;
 *   * `unknown` — тело передано, ответа нет. НЕ подтверждённый отказ получателя: он мог
 *     принять доставку. Повтор — с тем же eventId; повторные последствия возможны, если
 *     получатель не устраняет дубли;
 *   * `platform` — наша служба ключей: попытка не расходуется (блок 5).
 */
export type DeliveryFailureKind = 'receiver' | 'transport' | 'unknown' | 'platform';

const CERT_CODE = /^(CERT_|ERR_TLS_|ERR_SSL|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/;
/** Отказы DNS, которые говорят о самом резолвере, а не об имени получателя. */
const DNS_TRANSIENT = new Set(['EAI_AGAIN', 'ETIMEOUT', 'ESERVFAIL', 'ECONNREFUSED', 'ECANCELLED']);

export function classifyDeliveryFailure(error: unknown): DeliveryFailureKind {
  if (isKmsUnavailable(error)) return 'platform';
  const e = error as {
    code?: unknown;
    dnsCode?: unknown;
    deliveryPhase?: unknown;
    deliveryKind?: unknown;
    cause?: { code?: unknown };
  } | null;
  if (e?.dnsCode !== undefined) {
    return DNS_TRANSIENT.has(String(e.dnsCode)) ? 'transport' : 'receiver';
  }
  if (e?.deliveryKind === 'receiver') return 'receiver';
  const code = String(e?.code ?? e?.cause?.code ?? '');
  if (CERT_CODE.test(code)) return 'receiver';
  // Тело передано (соединение и TLS установлены) — исход неизвестен.
  if (e?.deliveryPhase === 'sent') return 'unknown';
  if (e?.deliveryPhase === 'connect') return 'transport';
  // Ошибка без признака фазы (проверка адреса, сборка запроса) — про этот адрес.
  return 'receiver';
}

/**
 * Временный сбой нашего резолвера (EAI_AGAIN, таймаут и т. п.): доставка откладывается БЕЗ
 * расхода попытки. Только DNS — обычные отказы соединения попытку расходуют.
 */
export function isTransientDns(error: unknown): boolean {
  const code = (error as { dnsCode?: unknown } | null)?.dnsCode;
  return code !== undefined && DNS_TRANSIENT.has(String(code));
}

/** Нормализованный узел назначения «хост:порт» — как столбец `destination` (M163). */
export function destinationOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname.toLowerCase()}:${parsed.port === '' ? '443' : parsed.port}`;
}

// ------------------------------------------------- предполагаемый общий сбой доставки
export type EgressGate = 'open' | 'paused' | 'probe';

/**
 * Предполагаемый общий сбой исходящей сети: транспортные отказы у `threshold` РАЗНЫХ узлов
 * назначения за `windowMs` без единого признака, что сеть работает (любой ответ получателя,
 * ошибка сертификата, неизвестный исход — соединение было). Признак, а не доказательство.
 *
 * Выход есть всегда: пауза ограничена; по её истечении — одна пробная доставка (`probe`).
 * Работающая сеть снимает признак, повторный транспортный отказ пробы удваивает паузу до
 * предела. Состояние — в экземпляре: перезапуск начинает с «открыто».
 */
export class EgressMonitor {
  private readonly failures = new Map<string, number>();
  private suspected = false;
  private pausedUntil = 0;
  private pauseMs = 0;

  constructor(
    private readonly options: {
      windowMs: number;
      threshold: number;
      basePauseMs: number;
      maxPauseMs: number;
    },
    private readonly clock: () => number = Date.now,
  ) {}

  transportFailure(destination: string): void {
    const now = this.clock();
    this.failures.set(destination, now);
    for (const [d, at] of this.failures) {
      if (now - at > this.options.windowMs) this.failures.delete(d);
    }
    if (this.suspected) {
      // Проба не прошла — пауза вдвое, до предела.
      this.pause(now);
      return;
    }
    if (this.failures.size >= this.options.threshold) {
      this.suspected = true;
      this.pause(now);
    }
  }

  /** Сеть до получателя работает: снять признак и паузу. */
  networkWorks(): void {
    this.failures.clear();
    this.suspected = false;
    this.pausedUntil = 0;
    this.pauseMs = 0;
  }

  gate(): EgressGate {
    if (!this.suspected) return 'open';
    return this.clock() < this.pausedUntil ? 'paused' : 'probe';
  }

  state(): { suspected: boolean; pausedUntil: number | null; destinations: number } {
    return {
      suspected: this.suspected,
      pausedUntil: this.suspected ? this.pausedUntil : null,
      destinations: this.failures.size,
    };
  }

  private pause(now: number): void {
    this.pauseMs = Math.min(
      Math.max(this.pauseMs * 2, this.options.basePauseMs),
      this.options.maxPauseMs,
    );
    this.pausedUntil = now + this.pauseMs;
  }
}

let egress: EgressMonitor | null = null;
let broker: Breaker | null = null;

export function egressMonitor(): EgressMonitor {
  egress ??= new EgressMonitor({
    windowMs: Number(process.env.WEBHOOK_EGRESS_WINDOW_MS ?? 60_000),
    threshold: Number(process.env.WEBHOOK_EGRESS_DESTINATIONS ?? 3),
    basePauseMs: Number(process.env.WEBHOOK_EGRESS_PAUSE_MS ?? 30_000),
    maxPauseMs: Number(process.env.WEBHOOK_EGRESS_PAUSE_MAX_MS ?? 600_000),
  });
  return egress;
}

/** Размыкатель брокера: исходы публикации и проверок стрима. */
export function brokerBreaker(): Breaker {
  broker ??= new Breaker({
    failures: Number(process.env.AVAILABILITY_BREAKER_FAILURES ?? 3),
    windowMs: Number(process.env.AVAILABILITY_BREAKER_WINDOW_MS ?? 60_000),
    openMs: Number(process.env.AVAILABILITY_BREAKER_OPEN_MS ?? 30_000),
  });
  return broker;
}

/** Для модульных проверок. */
export function resetEventsHealth(): void {
  egress = null;
  broker = null;
}

/** Пауза по получателю: начальная и предельная (с), из настроек. */
export function destinationPause(): { baseSeconds: number; maxSeconds: number } {
  return {
    baseSeconds: Number(process.env.WEBHOOK_DESTINATION_PAUSE_S ?? 30),
    maxSeconds: Number(process.env.WEBHOOK_DESTINATION_PAUSE_MAX_S ?? 3_600),
  };
}
