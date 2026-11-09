/**
 * Проверки Zabbix по файлу состояния архиватора журналов (8.4, 2.1-W08b).
 *
 * Каждая зависимая проверка разбирает файл сама и отвергает его, если он не
 * JSON, другого формата, время записи не целое число секунд, впереди часов
 * Zabbix больше чем на `SKEW_SEC` или старше `STALE_SEC`. Отвергнутый файл и
 * отсутствующее значение — ошибка предобработки: проверка «не
 * поддерживается», то есть «неизвестно». Числа вместо неизвестного не
 * подставляются (замечание Тэнка к ec3653d). Что именно не так с файлом,
 * показывает отдельная проверка `logs.file.problem` со своей тревогой: свежая
 * дата изменения файла не подтверждает его содержимое.
 *
 * Код предобработки — ES5 (движок Duktape в Zabbix 7).
 */
export const STALE_SEC = 300;
export const SKEW_SEC = 120;
export const BASELINE_MIN_HOURS = 72;
const FILL_STATES = ['ok', 'no-inflow', 'no-rate', 'no-limit', 'no-usage'];
const RISK_STATES = ['clear', 'ok', 'lost', 'unknown'];
/** Тревоги прежней формулы (заполнение предела) — сняты 09.11.2026: штатная ротация не авария. */
export const RETIRED_LOGS_TRIGGERS = [
  'Журналы: journald заполнится меньше чем за 48 ч',
  'Журналы: запас journald не вычисляется',
];

const LIB = [
  'function chk(value) {',
  "  var s; try { s = JSON.parse(value); } catch (e) { throw 'файл не JSON'; }",
  "  if (!s || typeof s !== 'object') throw 'файл не объект';",
  "  if (s.format !== 'logs-metrics/v1') throw 'неизвестный формат файла';",
  '  var t = s.atEpoch; var now = Math.floor(Date.now() / 1000);',
  "  if (typeof t !== 'number' || !isFinite(t) || Math.floor(t) !== t) throw 'время файла некорректно';",
  `  if (t > now + ${SKEW_SEC}) throw 'время файла в будущем';`,
  `  if (now - t > ${STALE_SEC}) throw 'файл состояния устарел';`,
  '  return s;',
  '}',
  "function int(v, what) { if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v || v < 0) throw 'нет значения: ' + what; return v; }",
  "function num(v, what) { if (typeof v !== 'number' || !isFinite(v)) throw 'нет значения: ' + what; return v; }",
  "function obj(v, what) { if (!v || typeof v !== 'object') throw 'нет значения: ' + what; return v; }",
  'function hour(s) { return obj(s.lastHour, "lastHour"); }',
].join(' ');

const js = (body) => `${LIB} var s = chk(value); ${body}`;

/** valueType: 0 — дробное, 3 — целое, 1 — строка. */
export const LOGS_ITEMS = [
  {
    key: 'logs.file.problem',
    name: 'Журналы: ошибка файла состояния (пусто — файл исправен)',
    valueType: 1,
    // Единственная проверка, которая не отвергает файл, а называет причину.
    js: `${LIB} try { chk(value); return ''; } catch (e) { return String(e); }`,
  },
  {
    key: 'logs.run.failure',
    name: 'Журналы: сбой прохода (код)',
    valueType: 1,
    js: js(
      "var r = obj(s.run, 'run'); if (typeof r.ok !== 'boolean') throw 'нет значения: run.ok'; if (r.failure === null) return ''; if (typeof r.failure !== 'string' || !/^[a-z-]{1,32}$/.test(r.failure)) throw 'нет значения: run.failure'; return r.failure;",
    ),
  },
  {
    key: 'logs.queue.lag',
    name: 'Журналы: отставание архива, с',
    valueType: 3,
    js: js("return int(obj(s.queue, 'очередь').lagSec, 'queue.lagSec');"),
  },
  {
    key: 'logs.queue.entries',
    name: 'Журналы: записей за курсором',
    valueType: 3,
    js: js("return int(obj(s.queue, 'очередь').entries, 'queue.entries');"),
  },
  {
    key: 'logs.losses.segments',
    name: 'Журналы: учтённых потерь, отрезков',
    valueType: 3,
    js: js("return int(obj(s.losses, 'losses').segments, 'losses.segments');"),
  },
  {
    key: 'logs.archive.gaps',
    name: 'Журналы: пропусков архива и неподтверждённых порций',
    valueType: 3,
    js: js("return int(s.archiveGaps, 'archiveGaps') + int(s.unconfirmed, 'unconfirmed');"),
  },
  {
    key: 'logs.hour.covered',
    name: 'Журналы: охват счётчиков часа, с',
    valueType: 3,
    js: js("return int(hour(s).coveredSec, 'lastHour.coveredSec');"),
  },
  {
    key: 'logs.journald.suppressed',
    name: 'Журналы: подавлено journald за час',
    valueType: 3,
    js: js("return int(hour(s).suppressed, 'lastHour.suppressed');"),
  },
  {
    key: 'logs.journald.risk_state',
    name: 'Журналы: риск потери невыгруженного — состояние (clear / ok / lost / unknown)',
    valueType: 1,
    js: js(
      `var r = obj(obj(s.journald, 'journald').risk, 'journald.risk'); if (${JSON.stringify(RISK_STATES)}.indexOf(r.state) < 0) throw 'нет значения: risk.state'; return r.state;`,
    ),
  },
  {
    key: 'logs.journald.risk_reason',
    name: 'Журналы: риск потери невыгруженного — причина «неизвестно» (пусто — вычислен)',
    valueType: 1,
    js: js(
      "var r = obj(obj(s.journald, 'journald').risk, 'journald.risk'); if (r.state !== 'unknown') return ''; if (typeof r.reason !== 'string' || !/^[a-z-]{1,32}$/.test(r.reason)) throw 'нет значения: risk.reason'; return r.reason;",
    ),
  },
  {
    key: 'logs.journald.risk_grace',
    name: 'Журналы: риск потери — отсрочка первого запуска (1 — идёт)',
    valueType: 3,
    js: js(
      "var r = obj(obj(s.journald, 'journald').risk, 'journald.risk'); if (typeof r.grace !== 'boolean') throw 'нет значения: risk.grace'; return r.grace ? 1 : 0;",
    ),
  },
  {
    key: 'logs.journald.risk_hours',
    name: 'Журналы: невыгруженное — оценка запаса при текущем притоке, ч',
    valueType: 0,
    js: js(
      "var r = obj(obj(s.journald, 'journald').risk, 'journald.risk'); if (r.state !== 'ok') throw 'оценки нет: ' + r.state; var h = num(r.hours, 'risk.hours'); if (h < 0) throw 'нет значения: risk.hours'; return h;",
    ),
  },
  {
    key: 'logs.journald.risk_if_stopped_hours',
    name: 'Журналы: запас при остановке выгрузки сейчас, ч (справочно)',
    valueType: 0,
    js: js(
      "var r = obj(obj(s.journald, 'journald').risk, 'journald.risk'); if (r.state !== 'ok' && r.state !== 'clear') throw 'оценки нет: ' + r.state; var h = num(r.ifStoppedHours, 'risk.ifStoppedHours'); if (h < 0) throw 'нет значения: risk.ifStoppedHours'; return h;",
    ),
  },
  {
    key: 'logs.journald.backlog_bytes',
    name: 'Журналы: невыгруженное — верхняя граница объёма на диске, байт',
    valueType: 3,
    js: js(
      "var r = obj(obj(s.journald, 'journald').risk, 'journald.risk'); if (r.state !== 'ok' && r.state !== 'clear') throw 'оценки нет: ' + r.state; return int(r.backlogBytes, 'risk.backlogBytes');",
    ),
  },
  {
    key: 'logs.journald.fill_state',
    name: 'Журналы: до штатной ротации — состояние расчёта (справочно)',
    valueType: 1,
    js: js(
      `var j = obj(s.journald, 'journald'); if (${JSON.stringify(FILL_STATES)}.indexOf(j.fillState) < 0) throw 'нет значения: journald.fillState'; return j.fillState;`,
    ),
  },
  {
    key: 'logs.journald.fill_hours',
    name: 'Журналы: до штатной ротации journald при текущем притоке, ч (справочно)',
    valueType: 0,
    js: js(
      "var j = obj(s.journald, 'journald'); if (j.fillState !== 'ok') throw 'запас не вычислен: ' + j.fillState; var h = num(j.fillHours, 'journald.fillHours'); if (h < 0) throw 'нет значения: journald.fillHours'; return h;",
    ),
  },
  {
    key: 'logs.journald.usage',
    name: 'Журналы: занято journald, байт',
    valueType: 3,
    js: js("return int(obj(s.journald, 'journald').usageBytes, 'journald.usageBytes');"),
  },
  {
    key: 'logs.inflow.hour',
    name: 'Журналы: приток за полный час, байт',
    valueType: 3,
    js: js(
      "var f = obj(s.inflow, 'inflow'); if (f.lastHourBytes === null) throw 'час счёта не полон'; return int(f.lastHourBytes, 'inflow.lastHourBytes');",
    ),
  },
  {
    key: 'logs.inflow.avg7d',
    name: 'Журналы: средний приток за час (до 7 суток), байт',
    valueType: 3,
    js: js(
      "var f = obj(s.inflow, 'inflow'); if (f.baselineReady !== true || f.avg7dHourBytes === null) throw 'база сравнения не накоплена'; return int(f.avg7dHourBytes, 'inflow.avg7dHourBytes');",
    ),
  },
  {
    key: 'logs.inflow.baseline_hours',
    name: 'Журналы: часов в базе сравнения притока',
    valueType: 3,
    js: js("return int(obj(s.inflow, 'inflow').baselineHours, 'inflow.baselineHours');"),
  },
  {
    key: 'logs.http.requests',
    name: 'Журналы: запросов ядра за час',
    valueType: 3,
    js: js("return int(hour(s).requests, 'lastHour.requests');"),
  },
  {
    key: 'logs.http.5xx_share',
    name: 'Журналы: доля 5xx за час, %',
    valueType: 0,
    js: js(
      "var h = hour(s); var n = int(h.requests, 'lastHour.requests'); var e = int(h.s5xx, 'lastHour.s5xx'); if (!n) throw 'запросов за час нет — доля не определена'; return Math.round((1000 * e) / n) / 10;",
    ),
  },
  {
    key: 'logs.http.fail2xx',
    name: 'Журналы: отказов внутри 2xx за час',
    valueType: 3,
    js: js("return int(hour(s).fail2xx, 'lastHour.fail2xx');"),
  },
  {
    key: 'logs.errors.total',
    name: 'Журналы: ошибок за час',
    valueType: 3,
    js: js(
      "var e = obj(hour(s).errors, 'lastHour.errors'); var n = 0; for (var k in e) n += int(e[k], 'lastHour.errors'); return n;",
    ),
  },
  {
    key: 'logs.errors.by',
    name: 'Журналы: ошибки за час по компонентам и кодам',
    valueType: 1,
    js: js(
      "var h = hour(s); var e = obj(h.errors, 'lastHour.errors'); var c = obj(h.codes, 'lastHour.codes'); var p = []; for (var k in e) p.push(k + ': ' + int(e[k], 'lastHour.errors')); for (var x in c) p.push('код ' + x + ': ' + int(c[x], 'lastHour.codes')); return p.join(', ');",
    ),
  },
  {
    key: 'logs.oom',
    name: 'Журналы: нехватка памяти (OOM) за час',
    valueType: 3,
    js: js("return int(hour(s).oom, 'lastHour.oom');"),
  },
  {
    key: 'logs.crashes',
    name: 'Журналы: аварийных завершений за час',
    valueType: 3,
    js: js("return int(hour(s).crashes, 'lastHour.crashes');"),
  },
  {
    key: 'logs.snapshot.age',
    name: 'Журналы: время без суточного снимка объёма, с',
    valueType: 3,
    // Снимка ещё не было — время от начала архива: тоже измеренная величина.
    js: js(
      `var now = Math.floor(Date.now() / 1000); var t = s.snapshot ? int(obj(s.snapshot, 'snapshot').lastEpoch, 'snapshot.lastEpoch') : int(s.archiveStartEpoch, 'archiveStartEpoch'); if (t > now + ${SKEW_SEC}) throw 'время снимка в будущем'; return Math.max(0, now - t);`,
    ),
  },
  {
    key: 'logs.files.age',
    name: 'Журналы: время без успешной архивации файлов почты, с',
    valueType: 3,
    // Успешного прохода ещё не было — время от начала архива.
    js: js(
      `if (s.files === null) throw 'файлы почты не настроены'; var now = Math.floor(Date.now() / 1000); var f = obj(s.files, 'files'); var t = f.lastOkEpoch === null ? int(s.archiveStartEpoch, 'archiveStartEpoch') : int(f.lastOkEpoch, 'files.lastOkEpoch'); if (t > now + ${SKEW_SEC}) throw 'время в будущем'; return Math.max(0, now - t);`,
    ),
  },
  {
    key: 'logs.files.bad',
    name: 'Журналы: источников файлов почты отсутствует или недоступно',
    valueType: 3,
    js: js(
      `if (s.files === null) throw 'файлы почты не настроены'; return int(obj(s.files, 'files').bad, 'files.bad');`,
    ),
  },
];

/** Тревоги: [название, выражение от H (узел), важность]. */
export function logsTriggers(H, file) {
  const l = (k) => `last(/${H}/${k})`;
  return [
    [
      'Журналы: состояние архиватора не обновляется (неизвестно)',
      `last(/${H}/vfs.file.time[${file},modify])>${STALE_SEC}`,
      3,
    ],
    [
      'Журналы: файл состояния некорректен или устарел по содержимому',
      `length(${l('logs.file.problem')})>0`,
      3,
    ],
    ['Журналы: проход архиватора не удался', `length(${l('logs.run.failure')})>0`, 3],
    ['Журналы: архив отстаёт больше 5 минут', `${l('logs.queue.lag')}>300`, 3],
    ['Журналы: новая учтённая потеря', `change(/${H}/logs.losses.segments)>0`, 3],
    ['Журналы: пропуск архива не закрыт', `${l('logs.archive.gaps')}>0`, 4],
    ['Журналы: journald подавляет записи', `${l('logs.journald.suppressed')}>0`, 2],
    // Риск потери невыгруженного (решение Тэнка и Томаса 09.11.2026). Время —
    // оценка при текущем притоке, не гарантия; отставание, всплеск притока и
    // учтённая потеря — своими тревогами. Без «state=ok» тревога висела бы на
    // прежнем значении: Zabbix не закрывает её по неподдерживаемой проверке.
    [
      'Журналы: невыгруженные записи удалены из journald',
      `${l('logs.journald.risk_state')}="lost"`,
      4,
    ],
    [
      'Журналы: при текущем притоке невыгруженное может быть вытеснено меньше чем за 48 ч (оценка)',
      `${l('logs.journald.risk_hours')}<48 and ${l('logs.journald.risk_state')}="ok"`,
      3,
    ],
    [
      // Неизвестное не считается безопасным; отсрочка — только первые 10
      // минут после первого расчёта на узле.
      'Журналы: риск потери невыгруженного не вычисляется',
      `${l('logs.journald.risk_state')}="unknown" and ${l('logs.journald.risk_grace')}=0`,
      3,
    ],
    [
      'Журналы: приток за час втрое выше среднего',
      `${l('logs.inflow.hour')}>3*${l('logs.inflow.avg7d')} and ${l('logs.inflow.hour')}>=104857600 and ${l('logs.inflow.baseline_hours')}>=${BASELINE_MIN_HOURS}`,
      2,
    ],
    [
      'Журналы: доля 5xx выше 5%',
      `${l('logs.http.5xx_share')}>5 and ${l('logs.http.requests')}>=20`,
      2,
    ],
    ['Журналы: отказы внутри 2xx', `${l('logs.http.fail2xx')}>0`, 1],
    ['Журналы: нехватка памяти (OOM)', `${l('logs.oom')}>0`, 3],
    ['Журналы: аварийное завершение процесса', `${l('logs.crashes')}>0`, 3],
    ['Журналы: суточного снимка объёма нет больше 26 ч', `${l('logs.snapshot.age')}>93600`, 2],
    ['Журналы: файлы почты не архивируются больше 26 ч', `${l('logs.files.age')}>93600`, 2],
    ['Журналы: источник файлов почты отсутствует или недоступен', `${l('logs.files.bad')}>0`, 3],
  ];
}
