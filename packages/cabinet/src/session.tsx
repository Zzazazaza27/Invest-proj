import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, Stack } from '@unicorn/ui';

/**
 * Проверка сессии: три исхода вместо двух.
 *
 * Раньше кабинет знал только «профиль пришёл» и «профиля нет». Всё, что не
 * 401, сваливалось во второе: `setMe(null)` — и человек видел каркас без
 * содержимого, то есть страницу вышедшего пользователя. Поймано проходом 7.4:
 * ограничитель частоты отвечал 429 на `GET /v1/auth/me`, и связный сценарий
 * выглядел как самопроизвольный выход из аккаунта.
 *
 * Это разные вещи, и путать их нельзя:
 *
 * - **absent** — сервер подтвердил отсутствие сессии (401). Здесь уместен
 *   переход на вход: идти больше некуда.
 * - **unavailable** — проверку выполнить не удалось (429, 5xx, сеть). Про
 *   сессию НИЧЕГО не известно: cookie на месте, сервер её просто не читал.
 *   Уводить отсюда на вход — значит по временной ошибке показать человеку
 *   чужое состояние, а если он при этом что-то набирал, потерять набранное.
 *
 * Пакет намеренно не знает ни про сеть, ни про класс ошибок клиента API:
 * поля читаются структурно. `instanceof ApiError` потребовал бы зависимости
 * от транспорта, а граница «кабинетные блоки в сеть не ходят» стоит дороже
 * точности проверки типа — тем более что поля здесь те же самые.
 */
export type SessionFailure =
  | { kind: 'absent' }
  | {
      kind: 'unavailable';
      /** Через сколько секунд сервер разрешает повтор; `null` — не сказал. */
      retryAfterSeconds: number | null;
      /** 429: отказ по частоте, а не поломка. Текст для человека другой. */
      rateLimited: boolean;
      status: number | null;
      traceId: string | null;
    };

interface ErrorShape {
  status?: unknown;
  retryAfterSeconds?: unknown;
  traceId?: unknown;
}

export function classifySessionFailure(error: unknown): SessionFailure {
  const shape: ErrorShape = typeof error === 'object' && error !== null ? error : {};
  const status = typeof shape.status === 'number' ? shape.status : null;

  // Только 401 означает «сессии нет». 403 сюда не относится: сессия есть, прав
  // не хватает — это решает уже маршрутизация по роли.
  if (status === 401) return { kind: 'absent' };

  return {
    kind: 'unavailable',
    retryAfterSeconds:
      typeof shape.retryAfterSeconds === 'number' && Number.isFinite(shape.retryAfterSeconds)
        ? Math.max(0, Math.ceil(shape.retryAfterSeconds))
        : null,
    rateLimited: status === 429,
    status,
    traceId: typeof shape.traceId === 'string' ? shape.traceId : null,
  };
}

/**
 * Экран «проверку сессии выполнить не удалось».
 *
 * Обязанностей три: сказать правду о состоянии, показать, что проверки идут,
 * и дать повторить руками.
 *
 * Про автоматический повтор причина отказа решает по-разному, и путать их
 * нельзя. Отказ по частоте (429) лечится паузой, а клиент, который в ответ
 * стучится сам, эту паузу и съедает: счётчик не опустеет, пока в него
 * стучатся, — значит повтор только по нажатию и не раньше названного
 * сервером срока. Поломка (5xx, обрыв связи) паузой не лечится и проходит
 * сама, а экран обещает человеку, что страница откроется как прежде. Без
 * собственной перепроверки обещание было ложным: страница висела до
 * перезагрузки, а нажатие при лежащем сервере выглядело как «ничего не
 * происходит». Перепроверяем сами — с растущей паузой (15 с, 30 с, … до
 * минуты) и видимым отсчётом.
 */
const AUTO_RECHECK_START = 15;
const AUTO_RECHECK_MAX = 60;

/** Сколько ждать перед попыткой номер `n`. */
function pauseFor(failure: Extract<SessionFailure, { kind: 'unavailable' }>, n: number): number {
  // Своя пауза есть только там, где перепроверяем сами. Срок сервера сильнее:
  // назвал больше — ждём столько, сколько назвал.
  const own = failure.rateLimited ? 0 : Math.min(AUTO_RECHECK_MAX, AUTO_RECHECK_START * n);
  return Math.max(failure.retryAfterSeconds ?? 0, own);
}

function clockOf(at: Date): string {
  return at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function SessionCheckFailed({
  failure,
  onRetry,
  busy = false,
}: {
  failure: Extract<SessionFailure, { kind: 'unavailable' }>;
  onRetry: () => void;
  busy?: boolean;
}): React.ReactElement {
  const auto = !failure.rateLimited;

  // Каждая неудачная проверка приходит новым объектом — по смене объекта и
  // считаем попытки. Счётчик, время и отсчёт живут одним состоянием: иначе
  // пауза успевала посчитаться по старому номеру попытки.
  const [tick, setTick] = useState(() => ({ n: 1, at: new Date(), left: pauseFor(failure, 1) }));
  const seen = useRef(failure);
  useEffect(() => {
    if (seen.current === failure) return;
    seen.current = failure;
    setTick((prev) => {
      const n = prev.n + 1;
      return { n, at: new Date(), left: pauseFor(failure, n) };
    });
  }, [failure]);

  useEffect(() => {
    if (tick.left <= 0) return;
    const timer = window.setTimeout(
      () => setTick((prev) => (prev.left <= 0 ? prev : { ...prev, left: prev.left - 1 })),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [tick]);

  // Обработчик держим в ref: приложения передают его новой функцией на каждый
  // рендер, и зависимость от него превратила бы перепроверку в цикл.
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;
  const firedFor = useRef<unknown>(null);
  useEffect(() => {
    if (!auto || busy || tick.left > 0) return;
    // Одна перепроверка на один отказ: пока не придёт новый, повтора не будет.
    if (firedFor.current === failure) return;
    firedFor.current = failure;
    retryRef.current();
  }, [auto, busy, tick.left, failure]);

  // Кнопка при поломке доступна всегда: отсчёт здесь — обещание перепроверки,
  // а не запрет. Запрещает только срок, названный сервером при 429.
  const canRetry = !busy && (auto || tick.left <= 0);

  const title = failure.rateLimited
    ? 'Слишком много запросов'
    : failure.status !== null
      ? 'Сервер временно недоступен'
      : 'Нет связи с сервером';

  const explanation = failure.rateLimited
    ? 'Сервер временно ограничил частоту обращений с этого адреса. Из аккаунта вы не вышли — ничего вводить заново не нужно.'
    : failure.status !== null
      ? `Сервер не смог ответить на проверку сессии (код ${failure.status}). Из аккаунта вы не вышли: как только он заработает, страница откроется как прежде — входить заново не придётся.`
      : 'Связаться с сервером не получилось. Из аккаунта вы не вышли: как только связь восстановится, страница откроется как прежде — входить заново не придётся.';

  const next = busy
    ? 'Проверяем…'
    : tick.left > 0
      ? auto
        ? `Следующая проверка через ${tick.left} с.`
        : `Повторить можно через ${tick.left} с.`
      : null;

  return (
    <Card>
      <Stack gap="var(--u-space-3)">
        <strong style={{ fontSize: 'var(--u-text-lg)' }} role="alert">
          {title}
        </strong>
        <span>{explanation}</span>
        <span
          style={{ color: 'var(--u-muted)' }}
          aria-live="polite"
          data-testid="session-retry-log"
        >
          {`Последняя проверка — в ${clockOf(tick.at)}${tick.n > 1 ? `, попыток: ${tick.n}` : ''}.`}
          {next ? ` ${next}` : ''}
        </span>
        <div>
          <Button variant="primary" onClick={onRetry} disabled={!canRetry}>
            {busy ? 'Проверяем…' : 'Проверить ещё раз'}
          </Button>
        </div>
        {failure.traceId ? (
          <span style={{ color: 'var(--u-muted)', fontSize: 'var(--u-text-sm)' }}>
            Код обращения: {failure.traceId}
          </span>
        ) : null}
      </Stack>
    </Card>
  );
}

/**
 * Хук проверки сессии для кабинета.
 *
 * Собирает вместе то, что во всех четырёх приложениях было скопировано и
 * успело разойтись: загрузка, различение 401 и временной ошибки, повтор по
 * нажатию. Сеть приходит функцией — пакет остаётся без транспорта.
 *
 * `onAbsent` вызывается только при подтверждённом 401: приложение само решает,
 * куда вести (у кабинетов это единый вход). При временной ошибке не
 * вызывается никогда — в этом вся суть.
 *
 * И `onReady`, и `onAbsent` могут вернуть `false` — «я увожу человека
 * отсюда, не снимай состояние проверки». Иначе на месте уходящей страницы
 * мелькнёт пустой каркас. Кабинет, который остаётся на месте и показывает
 * свою форму входа (админка), не возвращает ничего — и проверка снимается.
 */
export function useSessionCheck<T>(
  probe: () => Promise<T>,
  handlers: { onReady: (profile: T) => void | boolean; onAbsent: () => void | boolean },
): {
  checking: boolean;
  failure: Extract<SessionFailure, { kind: 'unavailable' }> | null;
  retry: () => void;
} {
  const [checking, setChecking] = useState(true);
  const [failure, setFailure] = useState<Extract<SessionFailure, { kind: 'unavailable' }> | null>(
    null,
  );
  // Ссылки на обработчики держим в ref: иначе каждый рендер приложения давал бы
  // новую функцию, а с ней — новый запуск проверки. Именно так рождаются
  // бесконечные циклы запросов.
  const bag = useRef(handlers);
  bag.current = handlers;
  const probeRef = useRef(probe);
  probeRef.current = probe;

  const run = useCallback(async () => {
    setChecking(true);
    try {
      const profile = await probeRef.current();
      setFailure(null);
      // `false` означает «профиль получен, но здесь этому человеку не место»:
      // приложение уже уводит его в другой кабинет, и снимать состояние
      // проверки не нужно — иначе на мгновение мелькнёт чужой экран.
      if (bag.current.onReady(profile) === false) return;
      setChecking(false);
    } catch (error) {
      const verdict = classifySessionFailure(error);
      if (verdict.kind === 'absent') {
        setFailure(null);
        if (bag.current.onAbsent() === false) return;
        setChecking(false);
        return;
      }
      setFailure(verdict);
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  return { checking, failure, retry: () => void run() };
}
