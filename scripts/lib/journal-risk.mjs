/**
 * Риск потери ещё не выгруженных записей journald (решение Тэнка и Томаса
 * 09.11.2026). Штатная ротация — удаление уже выгруженного — не авария;
 * опасно, когда journald удаляет файл с первой невыгруженной записью.
 *
 * Только заголовки файлов журнала, размеры на диске и сохранённые
 * метаданные — без чтения записей.
 *
 * Состояния:
 *   clear   — выгружено всё (граница совпала с концом журнала);
 *   ok      — есть невыгруженное, оценка запаса при текущем притоке;
 *   lost    — доказан пропуск невыгруженных записей (номера после границы
 *             отсутствуют во всех файлах журнала);
 *   unknown — оценку или непрерывность установить нельзя, с причиной.
 *             Неизвестное не считается безопасным.
 *
 * Объём — по целым файлам, в порядке удаления journald (journal-vacuum.c):
 * файл с первой невыгруженной записью и все файлы после него, вместе с
 * активными, считаются целиком. Это верхняя граница невыгруженного объёма:
 * мелкие выгруженные и крупные невыгруженные записи её не занижают. Файл с
 * первой невыгруженной записью удаляется, когда сумма этих файлов с новым
 * притоком превысит действующий предел. Запас — оценка при текущем притоке,
 * не гарантия: будущий приток и перезапуски journald (лишние файлы) могут
 * быть другими.
 */

export const RISK_GRACE_SEC = 600;
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const DEFAULT_FILE_MAX_UPPER = 128 * MiB;
const DEFAULT_USE_UPPER = 4 * GiB;
const DEFAULT_FILES_MAX = 100;
const HOUR_MS = 3_600_000;

export class RiskUnknown extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const unknown = (reason) => {
  throw new RiskUnknown(reason);
};

// ------------------------------------------------------------ заголовки

/**
 * Разбор `journalctl --header`: блоки, разделённые пустой строкой. Любое
 * отклонение от ожидаемого вида — unknown('header-ambiguous'), а не
 * догадка.
 */
export function parseHeaders(text) {
  const blocks = String(text)
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const files = [];
  for (const b of blocks) {
    const kv = new Map();
    for (const line of b.split('\n')) {
      const m = line.match(/^([A-Za-z][A-Za-z ]*?):[ \t]*(.*)$/);
      if (!m) continue;
      if (kv.has(m[1])) unknown('header-ambiguous');
      kv.set(m[1], m[2].trim());
    }
    const path = kv.get('File path');
    const seqId = kv.get('Sequential number ID');
    const state = kv.get('State');
    const entries = kv.get('Entry objects');
    if (!path || !path.startsWith('/')) unknown('header-ambiguous');
    if (!/^[0-9a-f]{32}$/.test(seqId ?? '')) unknown('header-ambiguous');
    if (!/^(ONLINE|OFFLINE|ARCHIVED)$/.test(state ?? '')) unknown('header-ambiguous');
    if (!/^\d+$/.test(entries ?? '')) unknown('header-ambiguous');
    const num = (k) => {
      const m = (kv.get(k) ?? '').match(/^(\d+) \(([0-9a-f]+)\)$/);
      if (!m || BigInt(m[1]) !== BigInt(`0x${m[2]}`)) unknown('header-ambiguous');
      return BigInt(m[1]);
    };
    const rt = (k) => {
      const m = (kv.get(k) ?? '').match(/\(([0-9a-f]+)\)$/);
      if (!m) unknown('header-ambiguous');
      return Number(BigInt(`0x${m[1]}`));
    };
    const n = Number(entries);
    const f = {
      path,
      seqId,
      state,
      entries: n,
      head: n ? num('Head sequential number') : null,
      tail: n ? num('Tail sequential number') : null,
      headRt: n ? rt('Head realtime timestamp') : null,
      tailRt: n ? rt('Tail realtime timestamp') : null,
    };
    if (n && (f.tail < f.head || f.tailRt < f.headRt)) unknown('header-ambiguous');
    files.push(f);
  }
  if (!files.length) unknown('no-files');
  if (new Set(files.map((f) => f.path)).size !== files.length) unknown('header-ambiguous');
  return files;
}

// ------------------------------------------------------------ порядок удаления

const ARCHIVED_NAME = /@([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{16})\.journal$/;
const CORRUPT_NAME = /@([0-9a-f]{16})-([0-9a-f]{16})\.journal~$/;

/**
 * Как journald видит файл при удалении (journal-vacuum.c): закрытый по
 * имени — удаляемый, с нумерацией, номером и временем начала из имени;
 * повреждённый «~» с временем в имени — удаляемый без нумерации; всё прочее
 * (активные system.journal, user-N.journal и имена без разбора) — активный:
 * не удаляется, но входит в сумму.
 */
export function vacuumInfo(path) {
  const name = path.split('/').pop();
  let m = name.match(ARCHIVED_NAME);
  if (m) {
    return {
      name,
      deletable: true,
      seqId: m[1],
      seq: BigInt(`0x${m[2]}`),
      realtime: BigInt(`0x${m[3]}`),
    };
  }
  m = name.match(CORRUPT_NAME);
  if (m) return { name, deletable: true, seqId: null, seq: null, realtime: BigInt(`0x${m[1]}`) };
  return { name, deletable: false };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Порядок удаления journald: старший первым. */
export function vacuumCompare(a, b) {
  if (a.seqId && b.seqId && a.seqId === b.seqId) return cmp(a.seq, b.seq);
  const r = cmp(a.realtime, b.realtime);
  if (r) return r;
  if (a.seqId && b.seqId) return cmp(a.seqId, b.seqId);
  return cmp(a.name, b.name);
}

/** Активный файл journald может пополняться; закрытый — нет. */
export const isOpenFile = (path) => /^[^@~]+\.journal$/.test(path.split('/').pop());

// ------------------------------------------------------------ настройки

const SIZE_UNITS = { '': 1, K: 1024, M: MiB, G: GiB, T: 1024 * GiB, P: 1024 ** 5, E: 1024 ** 6 };
function parseSize(v) {
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*([KMGTPE]?)B?$/i);
  if (!m) unknown('config');
  return Math.floor(Number(m[1]) * SIZE_UNITS[m[2].toUpperCase()]);
}

const SPAN_UNITS = {
  us: 1e-6,
  usec: 1e-6,
  ms: 1e-3,
  msec: 1e-3,
  s: 1,
  sec: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
  M: 2629800,
  month: 2629800,
  months: 2629800,
  y: 31557600,
  year: 31557600,
  years: 31557600,
};
function parseSpan(v) {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*([A-Za-z]+)/g)];
  if (
    !parts.length ||
    parts
      .map((p) => p[0])
      .join('')
      .replace(/\s/g, '') !== s.replace(/\s/g, '')
  )
    unknown('config');
  let sec = 0;
  for (const [, n, u] of parts) {
    // «M» — месяц, «m» — минута (systemd.time).
    const k = SPAN_UNITS[u] ?? SPAN_UNITS[u.toLowerCase()];
    if (k === undefined) unknown('config');
    sec += Number(n) * k;
  }
  return sec;
}

/**
 * Действующие настройки journald по выводу `systemd-analyze cat-config
 * systemd/journald.conf` (файлы подряд, позднее присваивание побеждает,
 * пустое — значение по умолчанию). Умолчания — journald-server.c /
 * journal-file.c: SystemMaxUse — 10% файловой системы, не больше 4 ГиБ;
 * SystemKeepFree — 15%, не больше 4 ГиБ; SystemMaxFileSize — 1/8 предела,
 * не больше 128 МиБ; SystemMaxFiles — 100; MaxRetentionSec — 0 (нет).
 */
export function parseJournaldConfig(text, fsSize) {
  let section = null;
  const v = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const s = line.match(/^\[(.+)\]$/);
    if (s) {
      section = s[1];
      continue;
    }
    if (section !== 'Journal') continue;
    const m = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (!m) unknown('config');
    if (m[2].trim() === '') delete v[m[1]];
    else v[m[1]] = m[2].trim();
  }
  const storage = v.Storage ?? 'auto';
  if (!['auto', 'persistent'].includes(storage)) unknown('config');
  if (!Number.isFinite(fsSize) || fsSize <= 0) unknown('config');
  const maxUse =
    v.SystemMaxUse !== undefined
      ? parseSize(v.SystemMaxUse)
      : Math.min(Math.floor(fsSize * 0.1), DEFAULT_USE_UPPER);
  const keepFree =
    v.SystemKeepFree !== undefined
      ? parseSize(v.SystemKeepFree)
      : Math.min(Math.floor(fsSize * 0.15), DEFAULT_USE_UPPER);
  const fileMax =
    v.SystemMaxFileSize !== undefined
      ? parseSize(v.SystemMaxFileSize)
      : Math.min(Math.floor(maxUse / 8), DEFAULT_FILE_MAX_UPPER);
  let maxFiles = DEFAULT_FILES_MAX;
  if (v.SystemMaxFiles !== undefined) {
    if (!/^\d+$/.test(v.SystemMaxFiles)) unknown('config');
    maxFiles = Number(v.SystemMaxFiles);
  }
  const retentionSec = v.MaxRetentionSec !== undefined ? parseSpan(v.MaxRetentionSec) : 0;
  return { storage, maxUse, keepFree, fileMax, maxFiles, retentionSec };
}

// ------------------------------------------------------------ непрерывность

/**
 * Что заголовки доказывают о номерах [a, b] одной нумерации. Системный и
 * user-файлы делят нумерацию, поэтому диапазон head…tail файла не значит, что
 * все его номера в нём. Группа перекрывающихся файлов доказывает полноту,
 * только если записей в ней ровно столько, сколько номеров в её диапазоне
 * (номер — ровно в одном файле). Иначе часть номеров пропала, но где — по
 * заголовкам не установить: ambiguous. Номера между группами нет ни в одном
 * файле — доказанный пропуск: holes.
 */
export function coverage(files, a, b) {
  const sorted = [...files].sort((x, y) => cmp(x.head, y.head));
  const groups = [];
  for (const f of sorted) {
    const g = groups.at(-1);
    if (g && f.head <= g.last) {
      if (f.tail > g.last) g.last = f.tail;
      g.entries += BigInt(f.entries);
    } else groups.push({ first: f.head, last: f.tail, entries: BigInt(f.entries) });
  }
  const holes = [];
  let ambiguous = false;
  let at = a;
  for (const g of groups) {
    if (g.last < a || g.first > b) continue;
    if (g.entries !== g.last - g.first + 1n) ambiguous = true;
    if (g.first > at) holes.push({ first: at, last: g.first - 1n });
    if (g.last + 1n > at) at = g.last + 1n;
  }
  if (at <= b) holes.push({ first: at, last: b });
  return { holes, ambiguous };
}

/** Доказанный пропуск — lost; неоднозначная полнота — unknown. */
function proveRange(files, sid, a, b) {
  const c = coverage(files, a, b);
  if (c.holes.length) return { lost: { seqId: sid, ...c.holes[0] } };
  if (c.ambiguous) unknown('continuity-unproven');
  return null;
}

/**
 * Невыгруженное: какие нумерации и номера, доказана ли непрерывность.
 * cursor — подтверждённая граница {seqId, seq, realtime|null (мкс)};
 * tail — последняя запись журнала {seqId, seq}.
 * Возвращает {clear: true} | {lost: {seqId, first, last}} |
 * {unarchived: (file) => boolean}.
 */
export function backlogOf(files, cursor, tail) {
  const withEntries = files.filter((f) => f.entries > 0);
  const bySid = new Map();
  for (const f of withEntries) bySid.set(f.seqId, [...(bySid.get(f.seqId) ?? []), f]);
  const C = cursor;
  const own = bySid.get(C.seqId) ?? [];
  const min = (xs) => xs.reduce((m, x) => (x < m ? x : m));
  const max = (xs) => xs.reduce((m, x) => (x > m ? x : m));

  // Другие нумерации — раньше границы (выгружены) или после неё.
  const later = [];
  const others = [...bySid.keys()].filter((s) => s !== C.seqId);
  if (others.length) {
    const before = C.realtime ?? (own.length ? min(own.map((f) => f.headRt)) : null);
    const after = C.realtime ?? (own.length ? max(own.map((f) => f.tailRt)) : null);
    if (before === null) unknown('no-cursor-time');
    for (const s of others) {
      const fs = bySid.get(s);
      const lo = min(fs.map((f) => f.headRt));
      const hi = max(fs.map((f) => f.tailRt));
      if (hi <= before) continue;
      if (lo >= after) later.push({ seqId: s, files: fs, lo });
      else unknown('numeration-overlap');
    }
  }
  later.sort((x, y) => x.lo - y.lo);

  if (!later.length) {
    if (tail.seqId !== C.seqId) unknown('numeration-order');
    if (tail.seq <= C.seq) return { clear: true };
    // Наличие C подтверждает только саму запись C: проверяется весь
    // невыгруженный отрезок.
    const p = proveRange(own, C.seqId, C.seq + 1n, tail.seq);
    if (p) return p;
    return { unarchived: (f) => f.seqId === C.seqId && f.entries > 0 && f.tail > C.seq };
  }

  // Переход нумерации: прежняя закрыта и её конец подтверждён, каждая
  // следующая начинается с 1 или продолжает счёт прежней.
  if (tail.seqId !== later.at(-1).seqId) unknown('numeration-order');
  const allClosed = (fs) => fs.every((f) => !isOpenFile(f.path));
  const chain = [{ seqId: C.seqId, files: own }, ...later];
  let prevEnd;
  if (own.length) {
    if (!allClosed(files.filter((f) => f.seqId === C.seqId))) unknown('transition-open');
    const end = max(own.map((f) => f.tail));
    if (end > C.seq) {
      const p = proveRange(own, C.seqId, C.seq + 1n, end);
      if (p) return p;
    }
    prevEnd = end > C.seq ? end : C.seq;
  } else {
    // Файлов прежней нумерации нет: конец доказывает только продолжение
    // счёта новой ровно за границей.
    const firstHead = min(later[0].files.map((f) => f.head));
    if (firstHead !== C.seq + 1n) unknown('transition-unproven');
    prevEnd = C.seq;
  }
  for (let i = 1; i < chain.length; i++) {
    const n = chain[i];
    if (i < chain.length - 1 && !allClosed(files.filter((f) => f.seqId === n.seqId)))
      unknown('transition-open');
    const lo = min(n.files.map((f) => f.head));
    const hi = max(n.files.map((f) => f.tail));
    if (lo !== 1n && lo !== prevEnd + 1n) unknown('transition-unproven');
    const p = proveRange(n.files, n.seqId, lo, hi);
    if (p) return p;
    prevEnd = hi;
  }
  const laterIds = new Set(later.map((n) => n.seqId));
  return {
    unarchived: (f) =>
      f.entries > 0 && ((f.seqId === C.seqId && f.tail > C.seq) || laterIds.has(f.seqId)),
  };
}

// ------------------------------------------------------------ запас

/**
 * Сколько новых файлов в час при текущем притоке: файлов на байт по
 * закрытым файлам за 7 суток (вместе с системным ротируются и user-файлы,
 * перезапуски journald дают лишние) × приток. Закрытых нет — шаг по самому
 * малому файлу.
 */
function filesPerHour(files, nowMs, rate) {
  const since = (nowMs - 7 * 24 * HOUR_MS) * 1000;
  const closed = files.filter((f) => f.vac.deletable && f.entries > 0 && f.headRt >= since);
  const bytes = closed.reduce((n, f) => n + f.size, 0);
  if (closed.length && bytes > 0) return (rate * closed.length) / bytes;
  return rate / Math.max(1, Math.min(...files.map((f) => f.size)));
}

/**
 * Запас при текущем притоке: когда journald удалит файл с первой
 * невыгруженной записью. files — заголовки с size (байт на диске, как
 * считает journald: st_blocks × 512) и vac (vacuumInfo); unarchived —
 * предикат файла с невыгруженным (null — невыгруженное только впереди, в
 * активных файлах).
 */
export function horizon({ files, unarchived, config, fsAvail, rate, nowMs }) {
  const list = files.filter((f) => f.vac.deletable).sort((a, b) => vacuumCompare(a.vac, b.vac));
  const active = files.filter((f) => !f.vac.deletable);
  const i0 = unarchived ? list.findIndex(unarchived) : -1;
  const from = i0 < 0 ? [] : list.slice(i0);
  const sum = (xs) => xs.reduce((n, f) => n + f.size, 0);
  const usage = sum(files);
  const backlog = sum(active) + sum(from);
  const limit = Math.max(0, Math.min(config.maxUse, usage + fsAvail - config.keepFree));
  const bounds = [];
  bounds.push(['bytes', Math.max(0, limit - config.fileMax - backlog) / rate]);
  if (config.maxFiles > 0) {
    // journald удаляет файл, когда за ним (с ним и активными) файлов больше
    // SystemMaxFiles.
    const left = active.length + from.length;
    bounds.push(['files', Math.max(0, config.maxFiles - left) / filesPerHour(files, nowMs, rate)]);
  }
  if (config.retentionSec > 0) {
    const firstRt = Math.min(
      ...(i0 < 0 ? active : from).filter((f) => f.entries > 0).map((f) => f.headRt),
    );
    if (Number.isFinite(firstRt)) {
      bounds.push([
        'retention',
        Math.max(0, (firstRt / 1000 + config.retentionSec * 1000 - nowMs) / HOUR_MS),
      ]);
    }
  }
  const [bound, hours] = bounds.reduce((m, b) => (b[1] < m[1] ? b : m));
  return {
    hours: Math.round(hours * 10) / 10,
    bound,
    backlogBytes: backlog,
    backlogFiles: from.length + active.length,
    usageBytes: usage,
    limitBytes: limit,
  };
}

/**
 * Полный расчёт. input: {files (заголовки + size), cursor, tail, config,
 * fsAvail, rate (байт на диске в час), nowMs}. Не бросает: неизвестное —
 * {state: 'unknown', reason}.
 */
export function computeRisk(input) {
  try {
    const { cursor, tail, config, fsAvail, rate, nowMs } = input;
    if (!cursor || cursor.seq === null || cursor.seq === undefined || !cursor.seqId)
      unknown('no-cursor');
    if (!tail) unknown('no-tail');
    const files = input.files.map((f) => ({ ...f, vac: vacuumInfo(f.path) }));
    // Непрерывность — до условий прогноза: доказанная потеря и подтверждённое
    // отсутствие невыгруженного не зависят от притока и настроек.
    const b = backlogOf(files, cursor, tail);
    if (b.lost) {
      return {
        state: 'lost',
        reason: '',
        lost: { seqId: b.lost.seqId, first: String(b.lost.first), last: String(b.lost.last) },
      };
    }
    // Для прогноза — настройки, место, приток и размеры.
    const forecastProblem = !config
      ? 'config'
      : !Number.isFinite(fsAvail)
        ? 'no-fs'
        : rate === null || rate === undefined || !Number.isFinite(rate)
          ? 'no-rate'
          : rate <= 0
            ? 'no-inflow'
            : files.some((f) => !Number.isFinite(f.size) || f.size < 0)
              ? 'no-size'
              : null;
    const base = { files, config, fsAvail, rate, nowMs };
    // Запас, если выгрузка остановится сейчас: первая невыгруженная запись
    // будет в активном файле — справочно.
    const ifStopped = forecastProblem ? null : horizon({ ...base, unarchived: null });
    if (b.clear) {
      return {
        state: 'clear',
        reason: '',
        hours: null,
        ifStoppedHours: ifStopped?.hours ?? null,
        forecastProblem,
        ...(ifStopped ? pick(ifStopped) : {}),
        backlogBytes: 0,
        backlogFiles: 0,
      };
    }
    if (forecastProblem) unknown(forecastProblem);
    const h = horizon({ ...base, unarchived: b.unarchived });
    return {
      state: 'ok',
      reason: '',
      hours: h.hours,
      ifStoppedHours: ifStopped.hours,
      ...pick(h),
    };
  } catch (error) {
    if (error instanceof RiskUnknown) return { state: 'unknown', reason: error.reason };
    return { state: 'unknown', reason: 'error' };
  }
}

const pick = (h) => ({
  bound: h.bound,
  backlogBytes: h.backlogBytes,
  backlogFiles: h.backlogFiles,
  usageBytes: h.usageBytes,
  limitBytes: h.limitBytes,
});

// ------------------------------------------------------------ приток на диске

/**
 * Рост файлов журнала между проходами — байты на диске, те же единицы, что
 * занятость и невыгруженный объём. Файл узнаётся по inode: ротация
 * переименовывает, а не копирует. Первый замер — только опорный.
 * track: {sizes: {ino: size}, hours: {hourKey: bytes}, since (мс)}.
 */
export function trackGrowth(track, files, nowMs) {
  const t = track ?? {};
  const first = !t.sizes;
  const sizes = {};
  let grow = 0;
  for (const f of files) {
    sizes[f.ino] = f.size;
    if (!first) {
      const prev = t.sizes[f.ino];
      grow += prev === undefined ? f.size : Math.max(0, f.size - prev);
    }
  }
  const hours = { ...(t.hours ?? {}) };
  const hk = Math.floor(nowMs / HOUR_MS);
  if (!first) hours[hk] = (hours[hk] ?? 0) + grow;
  for (const k of Object.keys(hours)) if (Number(k) < hk - 24 * 8) delete hours[k];
  return { sizes, hours, since: t.since ?? nowMs };
}

/**
 * Приток, байт на диске в час: большее из прироста за последний полный час,
 * среднего по полным часам замера (до 7 суток) и среднего по закрытым
 * файлам за 7 суток (заголовки: размер / время от первой до последней
 * записи) — последнее есть сразу после выпуска.
 */
export function diskRate(track, files, nowMs) {
  const nowH = Math.floor(nowMs / HOUR_MS);
  const firstH = Math.max(Math.ceil(track.since / HOUR_MS), nowH - 168);
  const full = [];
  for (let h = firstH; h < nowH; h++) full.push(track.hours[h] ?? 0);
  const lastHour = full.length ? full.at(-1) : null;
  const avg = full.length ? full.reduce((a, b) => a + b, 0) / full.length : null;
  const since = (nowMs - 7 * 24 * HOUR_MS) * 1000;
  const closed = files.filter(
    (f) => !isOpenFile(f.path) && f.entries > 0 && f.tailRt >= since && f.headRt >= since,
  );
  let fromFiles = null;
  if (closed.length) {
    const span =
      (Math.max(...closed.map((f) => f.tailRt)) - Math.min(...closed.map((f) => f.headRt))) / 1e6;
    if (span >= 3600) fromFiles = (closed.reduce((n, f) => n + f.size, 0) / span) * 3600;
  }
  const all = [
    ['hour', lastHour],
    ['avg', avg],
    ['files', fromFiles],
  ].filter(([, v]) => v !== null);
  if (!all.length) return { rate: null, source: null };
  const [source, rate] = all.reduce((m, x) => (x[1] > m[1] ? x : m));
  return { rate: Math.round(rate), source };
}
