/**
 * Безопасная запись технического журнала (блок 8, 8.4; 2.1-W08b).
 *
 * Секрет убирается ДО первой записи, а не перед архивом: в журнал попадают
 * только поля из перечня, строки проходят маскировку, исключение сводится к
 * классу, коду и кадрам стека без текста. Неизвестные поля не пишутся — в
 * записи остаются лишь их имена (`dropped`), чтобы пропажа была видна.
 *
 * Почему перечень, а не «вычёркивание опасного»: опасное заранее не
 * перечислить (тексты ошибок драйверов несут значения полей — «Key (…)=(…)»,
 * `invalid input syntax: "…"`), а новое поле в вызове логгера не должно
 * молча начать писать данные.
 */

/** Поля, которые пишутся как есть (строки — после маскировки). */
const ALLOWED = new Set([
  'msg',
  'code',
  'sqlstate',
  'errorName',
  'requestId',
  'stage',
  'subject',
  'what',
  'entity',
  'reason',
  'dependency',
  'flag',
  'status',
  'method',
  'route',
  'durationMs',
  'result',
  'count',
  'limit',
  'size',
  'attempts',
  'delaySeconds',
  'failures',
  'pending',
  'jobs',
  'job',
  'instance',
  'stream',
  'eventType',
  'type',
  'kind',
  'verb',
  'pool',
  'relay',
  'hasInbox',
  'mailAvailable',
  'messages',
  'subjects',
  'unknownSince',
  'error',
  'frames',
  // Идентификаторы — только там, где вызов сам их передал для разбора (8.4);
  // в метрики они не идут.
  'id',
  'userId',
  'projectId',
  'ticketId',
  'sessionId',
  'uploadId',
  'deliveryId',
  'contextId',
  'clientId',
]);

/** Прежние имена полей → новые. */
const RENAMED: Record<string, string> = { traceId: 'requestId' };

/** Вложенные объекты, чьи разрешённые поля поднимаются на верхний уровень. */
const FLATTENED = new Set(['internal']);

const MAX_TEXT = 500;

/**
 * Маскировка произвольного текста: сообщений библиотек, причин, ошибок.
 * Порядок важен — сначала целые конструкции (URL с паролем, JWT), потом пары
 * «ключ=значение», потом значения в кавычках и скобках.
 */
export function sanitizeText(input: string): string {
  let s = input;
  // Учётные данные в адресе: scheme://user:pass@host
  s = s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1***@');
  // Query в адресах и путях: всё после «?» до пробела или кавычки
  s = s.replace(/\?[^\s"'<>]+/g, '?…');
  // Bearer/Basic
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  // JWT
  s = s.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '***');
  // Пары с секретом: password=…, token: …, "cookie":"…"
  s = s.replace(
    /\b(pass(?:word|wd)?|pwd|secret|token|api[_-]?key|authorization|cookie|session(?:id)?|otp|code_verifier)("?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&)]+)/gi,
    '$1$2***',
  );
  // Значения ограничений PostgreSQL: Key (col)=(value)
  s = s.replace(/\(([^()]{0,200})\)=\(([^()]{0,500})\)/g, '($1)=(…)');
  // Значения в кавычках (литералы и тексты драйверов)
  s = s.replace(/"[^"\n]{1,500}"/g, '"…"');
  s = s.replace(/'[^'\n]{1,500}'/g, "'…'");
  // Адреса почты
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '…@…');
  // Управляющие символы не разрывают строку журнала
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

function safeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => (typeof v === 'object' ? '[object]' : safeValue(v)));
  }
  if (value instanceof Error) return safeError(value).errorName;
  return '[object]';
}

/**
 * Исключение — без текста: класс, код драйвера (SQLSTATE и т.п.) и до пяти
 * кадров стека без первой строки (в ней текст). Текст ошибки не пишется
 * вовсе: у драйверов в нём значения полей.
 */
export function safeError(error: unknown): {
  errorName: string;
  sqlstate?: string;
  frames?: string[];
} {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const out: { errorName: string; sqlstate?: string; frames?: string[] } = {
    errorName: error.constructor?.name || error.name || 'Error',
  };
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) out.sqlstate = code;
  if (error.stack) {
    const frames = error.stack
      .split('\n')
      .filter((l) => /^\s+at /.test(l))
      .slice(0, 5)
      .map((l) => sanitizeText(l.trim()));
    if (frames.length) out.frames = frames;
  }
  return out;
}

/**
 * Поля записи: только разрешённые, строки — маскированные; вложенные
 * `internal` поднимаются; объект ошибки — через safeError.
 */
export function safeFields(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  const put = (rawKey: string, value: unknown): void => {
    if (value === undefined) return;
    const key = RENAMED[rawKey] ?? rawKey;
    if (FLATTENED.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) put(k, v);
      return;
    }
    if (key === 'error' && value instanceof Error) {
      Object.assign(out, safeError(value));
      return;
    }
    if (key === 'error' && value && typeof value === 'object' && !Array.isArray(value)) {
      // Прежняя форма { message, stack }: текст не пишется, только кадры.
      const stack = (value as { stack?: unknown }).stack;
      if (typeof stack === 'string') {
        const fake = new Error();
        fake.stack = stack;
        const frames = safeError(fake).frames;
        if (frames) out.frames = frames;
      }
      return;
    }
    if (!ALLOWED.has(key)) {
      dropped.push(key);
      return;
    }
    out[key] = safeValue(value);
  };
  for (const [k, v] of Object.entries(input)) put(k, v);
  if (dropped.length) out.dropped = dropped.slice(0, 20);
  return out;
}
