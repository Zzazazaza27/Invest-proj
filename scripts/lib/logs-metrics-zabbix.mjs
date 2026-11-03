/**
 * Проверки Zabbix по файлу состояния архиватора журналов (8.4, 2.1-W08b).
 *
 * Каждая зависимая проверка разбирает файл сама: файл старше
 * `STALE_SEC` — ошибка предобработки, проверка «не поддерживается», то есть
 * «неизвестно», а не прежние нули; об устаревании сообщает отдельная тревога
 * по возрасту файла. Код предобработки — ES5 (движок Duktape в Zabbix 7).
 */
export const STALE_SEC = 300;

const head = `var s = JSON.parse(value); if (Math.floor(Date.now() / 1000) - s.atEpoch > ${STALE_SEC}) throw 'файл состояния устарел';`;

/** valueType: 0 — дробное, 3 — целое, 1 — строка. */
export const LOGS_ITEMS = [
  {
    key: 'logs.run.failure',
    name: 'Журналы: сбой прохода (код)',
    valueType: 1,
    js: `${head} return s.run.failure || '';`,
  },
  {
    key: 'logs.queue.lag',
    name: 'Журналы: отставание архива, с',
    valueType: 3,
    js: `${head} if (!s.queue) throw 'очередь не прочитана'; return s.queue.lagSec;`,
  },
  {
    key: 'logs.queue.entries',
    name: 'Журналы: записей за курсором',
    valueType: 3,
    js: `${head} if (!s.queue) throw 'очередь не прочитана'; return s.queue.entries;`,
  },
  {
    key: 'logs.losses.segments',
    name: 'Журналы: учтённых потерь, отрезков',
    valueType: 3,
    js: `${head} return s.losses.segments;`,
  },
  {
    key: 'logs.archive.gaps',
    name: 'Журналы: пропусков архива',
    valueType: 3,
    js: `${head} return s.archiveGaps + s.unconfirmed;`,
  },
  {
    key: 'logs.journald.suppressed',
    name: 'Журналы: подавлено journald за час',
    valueType: 3,
    js: `${head} return s.lastHour.suppressed;`,
  },
  {
    key: 'logs.journald.fill_hours',
    name: 'Журналы: запас journald до заполнения, ч',
    valueType: 0,
    js: `${head} return s.journald.fillHours === null ? 999999 : s.journald.fillHours;`,
  },
  {
    key: 'logs.journald.usage',
    name: 'Журналы: занято journald, байт',
    valueType: 3,
    js: `${head} if (s.journald.usageBytes === null) throw 'занятость не прочитана'; return s.journald.usageBytes;`,
  },
  {
    key: 'logs.inflow.hour',
    name: 'Журналы: приток за час, байт',
    valueType: 3,
    js: `${head} return s.inflow.lastHourBytes;`,
  },
  {
    key: 'logs.inflow.avg7d',
    name: 'Журналы: средний приток за час (7 суток), байт',
    valueType: 3,
    js: `${head} return s.inflow.avg7dHourBytes === null ? 0 : s.inflow.avg7dHourBytes;`,
  },
  {
    key: 'logs.http.requests',
    name: 'Журналы: запросов ядра за час',
    valueType: 3,
    js: `${head} return s.lastHour.requests;`,
  },
  {
    key: 'logs.http.5xx_share',
    name: 'Журналы: доля 5xx за час, %',
    valueType: 0,
    js: `${head} var h = s.lastHour; return h.requests ? Math.round((1000 * h.s5xx) / h.requests) / 10 : 0;`,
  },
  {
    key: 'logs.http.fail2xx',
    name: 'Журналы: отказов внутри 2xx за час',
    valueType: 3,
    js: `${head} return s.lastHour.fail2xx;`,
  },
  {
    key: 'logs.errors.total',
    name: 'Журналы: ошибок за час',
    valueType: 3,
    js: `${head} var n = 0; for (var k in s.lastHour.errors) n += s.lastHour.errors[k]; return n;`,
  },
  {
    key: 'logs.errors.by',
    name: 'Журналы: ошибки за час по компонентам и кодам',
    valueType: 1,
    js: `${head} var p = []; var e = s.lastHour.errors; var c = s.lastHour.codes; for (var k in e) p.push(k + ': ' + e[k]); for (var x in c) p.push('код ' + x + ': ' + c[x]); return p.join(', ');`,
  },
  {
    key: 'logs.oom',
    name: 'Журналы: нехватка памяти (OOM) за час',
    valueType: 3,
    js: `${head} return s.lastHour.oom;`,
  },
  {
    key: 'logs.crashes',
    name: 'Журналы: аварийных завершений за час',
    valueType: 3,
    js: `${head} return s.lastHour.crashes;`,
  },
  {
    key: 'logs.snapshot.age',
    name: 'Журналы: возраст суточного снимка объёма, с',
    valueType: 3,
    js: `${head} return s.snapshot ? Math.floor(Date.now() / 1000) - s.snapshot.lastEpoch : 999999;`,
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
    ['Журналы: проход архиватора не удался', `length(${l('logs.run.failure')})>0`, 3],
    ['Журналы: архив отстаёт больше 5 минут', `${l('logs.queue.lag')}>300`, 3],
    ['Журналы: новая учтённая потеря', `change(/${H}/logs.losses.segments)>0`, 3],
    ['Журналы: пропуск архива не закрыт', `${l('logs.archive.gaps')}>0`, 4],
    ['Журналы: journald подавляет записи', `${l('logs.journald.suppressed')}>0`, 2],
    ['Журналы: journald заполнится меньше чем за 48 ч', `${l('logs.journald.fill_hours')}<48`, 3],
    [
      'Журналы: приток за час втрое выше среднего',
      `${l('logs.inflow.hour')}>3*${l('logs.inflow.avg7d')} and ${l('logs.inflow.hour')}>=104857600`,
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
  ];
}
