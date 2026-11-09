import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — модуль скриптов на JS без деклараций.
import * as jr from '../../../scripts/lib/journal-risk.mjs';
// @ts-expect-error — модуль скриптов на JS без деклараций.
import { LOGS_ITEMS, logsTriggers } from '../../../scripts/lib/logs-metrics-zabbix.mjs';

const {
  computeRisk,
  diskRate,
  parseHeaders,
  parseJournaldConfig,
  trackGrowth,
  vacuumCompare,
  vacuumInfo,
} = jr;

/**
 * Риск потери невыгруженных записей journald (решение Тэнка и Томаса
 * 09.11.2026): состояния clear / ok / lost / unknown, объём по целым файлам
 * в порядке удаления journald, непрерывность по номерам и нумерациям.
 */

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const DIR = '/var/log/journal/m';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const H = 3_600_000;
const hex16 = (n: bigint | number) => BigInt(n).toString(16).padStart(16, '0');
const us = (ms: number) => ms * 1000;

type F = {
  path: string;
  seqId: string;
  state: string;
  entries: number;
  head: bigint | null;
  tail: bigint | null;
  headRt: number | null;
  tailRt: number | null;
  size: number;
};

/** Закрытый файл: имя как у journald (нумерация, первый номер, время первой записи). */
function closed(sid: string, head: number, tail: number, hoursAgo: number, size: number): F {
  const headRt = us(NOW - hoursAgo * H);
  return {
    path: `${DIR}/system@${sid}-${hex16(head)}-${hex16(headRt)}.journal`,
    seqId: sid,
    state: 'ARCHIVED',
    entries: tail - head + 1,
    head: BigInt(head),
    tail: BigInt(tail),
    headRt,
    tailRt: headRt + us(H / 2),
    size,
  };
}
function active(sid: string, head: number, tail: number, hoursAgo: number, size: number): F {
  return {
    ...closed(sid, head, tail, hoursAgo, size),
    path: `${DIR}/system.journal`,
    state: 'ONLINE',
  };
}

const CONFIG = {
  storage: 'persistent',
  maxUse: 4 * GiB,
  keepFree: 15 * GiB,
  fileMax: 128 * MiB,
  maxFiles: 100,
  retentionSec: 0,
};
const base = {
  config: CONFIG,
  fsAvail: 93 * GiB,
  rate: 20 * MiB,
  nowMs: NOW,
};
const at = (seqId: string, seq: number, rtHoursAgo: number | null = null) => ({
  seqId,
  seq: BigInt(seq),
  realtime: rtHoursAgo === null ? null : us(NOW - rtHoursAgo * H),
});

describe('состояния', () => {
  const files = [
    closed(A, 1, 1000, 10, 48 * MiB),
    closed(A, 1001, 2000, 6, 48 * MiB),
    active(A, 2001, 2500, 2, 24 * MiB),
  ];

  it('всё выгружено, F нет — clear, а не unknown; запас при остановке — справочно', () => {
    const r = computeRisk({ ...base, files, cursor: at(A, 2500), tail: at(A, 2500) });
    expect(r.state).toBe('clear');
    expect(r.hours).toBeNull();
    expect(r.backlogBytes).toBe(0);
    // При остановке сейчас первая невыгруженная — в активном файле.
    expect(r.ifStoppedHours).toBeCloseTo((4 * GiB - 128 * MiB - 24 * MiB) / (20 * MiB), 0);
  });

  it('невыгруженное в активном файле — ok, объём — весь активный файл', () => {
    const r = computeRisk({ ...base, files, cursor: at(A, 2400), tail: at(A, 2500) });
    expect(r.state).toBe('ok');
    expect(r.backlogBytes).toBe(24 * MiB);
    expect(r.bound).toBe('bytes');
  });

  it('C удалён ротацией, следующая запись сохранена — потери нет', () => {
    // Файл с записями 1–1000 удалён; граница — запись 1000, дальше 1001.
    const r = computeRisk({
      ...base,
      files: files.slice(1),
      cursor: at(A, 1000),
      tail: at(A, 2500),
    });
    expect(r.state).toBe('ok');
  });

  it('после C действительно нет записей — lost с номерами', () => {
    const r = computeRisk({
      ...base,
      files: files.slice(1),
      cursor: at(A, 900),
      tail: at(A, 2500),
    });
    expect(r).toMatchObject({ state: 'lost', lost: { seqId: A, first: '901', last: '1000' } });
  });

  it('потеря внутри отрезка не скрывается наличием C', () => {
    // C = 500 есть (первый файл), файла 1001–2000 нет.
    const r = computeRisk({
      ...base,
      files: [files[0], files[2]],
      cursor: at(A, 500),
      tail: at(A, 2500),
    });
    expect(r).toMatchObject({ state: 'lost', lost: { first: '1001', last: '2000' } });
  });
});

describe('объём по целым файлам', () => {
  it('много мелких выгруженных и несколько крупных невыгруженных — запас не завышается', () => {
    // 60 файлов по 1 МиБ — выгружены; 3 файла по 40 МиБ и активный 30 МиБ
    // — невыгружены. По доле записей невыгруженное — малая часть журнала.
    const small = Array.from({ length: 60 }, (_, i) =>
      closed(A, i * 1000 + 1, (i + 1) * 1000, 100 - i, 1 * MiB),
    );
    const big = [
      closed(A, 60001, 60010, 30, 40 * MiB),
      closed(A, 60011, 60020, 20, 40 * MiB),
      closed(A, 60021, 60030, 10, 40 * MiB),
    ];
    const act = active(A, 60031, 60040, 5, 30 * MiB);
    const files = [...small, ...big, act];
    const cfg = { ...CONFIG, maxUse: 512 * MiB, fileMax: 16 * MiB };
    const r = computeRisk({
      ...base,
      config: cfg,
      files,
      cursor: at(A, 60000),
      tail: at(A, 60040),
    });
    const unarchived = 3 * 40 * MiB + 30 * MiB;
    expect(r.state).toBe('ok');
    expect(r.backlogBytes).toBeGreaterThanOrEqual(unarchived);
    expect(r.hours).toBeLessThanOrEqual((512 * MiB - 16 * MiB - unarchived) / (20 * MiB) + 0.05);
    // Прежняя оценка «доля записей × занятость» дала бы почти весь предел.
    const usage = 60 * MiB + unarchived;
    const byShare = (40 / 60040) * usage;
    expect((512 * MiB - 16 * MiB - byShare) / (20 * MiB)).toBeGreaterThan(r.hours + 5);
  });

  it('первая невыгруженная в середине файла — файл считается целиком', () => {
    const files = [
      closed(A, 1, 1000, 10, 48 * MiB),
      closed(A, 1001, 2000, 6, 48 * MiB),
      active(A, 2001, 2500, 2, 24 * MiB),
    ];
    const r = computeRisk({ ...base, files, cursor: at(A, 1500), tail: at(A, 2500) });
    expect(r.backlogBytes).toBe(72 * MiB);
  });

  it('предел — меньшее из SystemMaxUse и места с учётом SystemKeepFree', () => {
    const files = [closed(A, 1, 1000, 10, 48 * MiB), active(A, 1001, 2000, 2, 24 * MiB)];
    const r = computeRisk({
      ...base,
      fsAvail: 15 * GiB + 200 * MiB,
      files,
      cursor: at(A, 1500),
      tail: at(A, 2000),
    });
    expect(r.limitBytes).toBe(72 * MiB + 200 * MiB);
    expect(r.hours).toBeCloseTo((272 * MiB - 128 * MiB - 24 * MiB) / (20 * MiB), 1);
  });

  it('предел числа файлов и срок хранения ограничивают запас, если действуют', () => {
    const files = [
      closed(A, 1, 1000, 10, 48 * MiB),
      closed(A, 1001, 2000, 6, 48 * MiB),
      active(A, 2001, 2500, 2, 24 * MiB),
    ];
    const f = computeRisk({
      ...base,
      config: { ...CONFIG, maxFiles: 4 },
      files,
      cursor: at(A, 1500),
      tail: at(A, 2500),
    });
    expect(f.bound).toBe('files');
    // Свободных мест — 2 файла; файл на 48 МиБ притока.
    expect(f.hours).toBeCloseTo((2 * 48 * MiB) / (20 * MiB), 1);
    const t = computeRisk({
      ...base,
      config: { ...CONFIG, retentionSec: 7 * 3600 },
      files,
      cursor: at(A, 1500),
      tail: at(A, 2500),
    });
    // Первая невыгруженная — в файле, начатом 6 ч назад: удалится через 1 ч.
    expect(t).toMatchObject({ bound: 'retention', hours: 1 });
  });

  it('порядок удаления — как у journald: по номеру внутри нумерации, по времени между', () => {
    const x = vacuumInfo(`${DIR}/system@${A}-${hex16(10)}-${hex16(500)}.journal`);
    const y = vacuumInfo(`${DIR}/system@${A}-${hex16(5)}-${hex16(900)}.journal`);
    const z = vacuumInfo(`${DIR}/system@${B}-${hex16(1)}-${hex16(100)}.journal`);
    expect(vacuumCompare(y, x)).toBeLessThan(0);
    expect(vacuumCompare(z, x)).toBeLessThan(0);
    expect(vacuumInfo(`${DIR}/system.journal`).deletable).toBe(false);
    expect(vacuumInfo(`${DIR}/system.journal~`).deletable).toBe(false);
    expect(vacuumInfo(`${DIR}/system@${hex16(7)}-${hex16(9)}.journal~`).deletable).toBe(true);
  });
});

describe('переход нумерации', () => {
  const old = [closed(A, 1, 1000, 10, 48 * MiB)];
  it('прежняя закрыта и дочитана до C, новая с 1 — корректный переход', () => {
    const r = computeRisk({
      ...base,
      files: [...old, active(B, 1, 300, 4, 16 * MiB)],
      cursor: at(A, 1000, 9.5),
      tail: at(B, 300),
    });
    expect(r.state).toBe('ok');
    expect(r.backlogBytes).toBe(16 * MiB);
  });

  it('новая продолжает счёт прежней — корректный переход', () => {
    const r = computeRisk({
      ...base,
      files: [...old, active(B, 1001, 1300, 4, 16 * MiB)],
      cursor: at(A, 1000, 9.5),
      tail: at(B, 1300),
    });
    expect(r.state).toBe('ok');
  });

  it('файл прежней нумерации ещё может пополниться — переход не завершён', () => {
    const r = computeRisk({
      ...base,
      files: [
        { ...old[0], path: `${DIR}/user-1000.journal`, state: 'ONLINE' },
        active(B, 1, 300, 4, 16 * MiB),
      ],
      cursor: at(A, 1000, 9.5),
      tail: at(B, 300),
    });
    expect(r).toMatchObject({ state: 'unknown', reason: 'transition-open' });
  });

  it('файлов прежней нумерации нет, новая с 1 — непрерывность не доказана', () => {
    const r = computeRisk({
      ...base,
      files: [active(B, 1, 300, 4, 16 * MiB)],
      cursor: at(A, 1000, 9.5),
      tail: at(B, 300),
    });
    expect(r).toMatchObject({ state: 'unknown', reason: 'transition-unproven' });
  });

  it('новая начинается не с 1 и не за концом прежней — непрерывность не доказана', () => {
    const r = computeRisk({
      ...base,
      files: [...old, active(B, 1500, 1800, 4, 16 * MiB)],
      cursor: at(A, 1000, 9.5),
      tail: at(B, 1800),
    });
    expect(r).toMatchObject({ state: 'unknown', reason: 'transition-unproven' });
  });

  it('смена нумерации сама по себе не потеря', () => {
    const r = computeRisk({
      ...base,
      files: [...old, closed(B, 1, 300, 4, 16 * MiB), active(B, 301, 400, 1, 8 * MiB)],
      cursor: at(B, 400),
      tail: at(B, 400),
    });
    expect(r.state).toBe('clear');
  });
});

describe('заголовок не доказывает полноту диапазона (замечание Тэнка к 35d9fe8)', () => {
  it('файл 1–100 с 50 записями, C = 40 — полнота 41–100 не доказана: unknown', () => {
    const f = { ...closed(A, 1, 100, 3, 8 * MiB), entries: 50 };
    const r = computeRisk({
      ...base,
      files: [f, active(A, 101, 120, 1, 8 * MiB)],
      cursor: at(A, 40),
      tail: at(A, 120),
    });
    expect(r).toMatchObject({ state: 'unknown', reason: 'continuity-unproven' });
  });

  it('удалён user-файл с номерами внутри диапазона system-файла — unknown, а не ok', () => {
    // System и user делят нумерацию: вместе 70 + 30 = 100 номеров 1–100.
    const sys = { ...closed(A, 1, 100, 3, 40 * MiB), entries: 70 };
    const usr = {
      ...closed(A, 10, 90, 3, 4 * MiB),
      path: `${DIR}/user-1000@${A}-${hex16(10)}-${hex16(us(NOW - 3 * H))}.journal`,
      entries: 30,
    };
    const act = active(A, 101, 120, 1, 8 * MiB);
    const both = computeRisk({
      ...base,
      files: [sys, usr, act],
      cursor: at(A, 40),
      tail: at(A, 120),
    });
    expect(both.state).toBe('ok');
    const gone = computeRisk({ ...base, files: [sys, act], cursor: at(A, 40), tail: at(A, 120) });
    expect(gone).toMatchObject({ state: 'unknown', reason: 'continuity-unproven' });
  });
});

describe('непрерывность не зависит от прогноза (замечание Тэнка к 35d9fe8)', () => {
  const files = [closed(A, 50, 100, 3, 8 * MiB), active(A, 101, 120, 1, 8 * MiB)];
  it.each([
    ['известен приток', {}],
    ['нет притока', { rate: null }],
    ['нет настроек', { config: null }],
    ['нет места', { fsAvail: null }],
  ])('доказанный пропуск 41–49 — lost: %s', (_n, over) => {
    const r = computeRisk({ ...base, files, cursor: at(A, 40), tail: at(A, 120), ...over });
    expect(r).toMatchObject({ state: 'lost', lost: { first: '41', last: '49' } });
  });

  it('всё выгружено без измеренного притока — clear, прогноза нет', () => {
    const r = computeRisk({ ...base, rate: null, files, cursor: at(A, 120), tail: at(A, 120) });
    expect(r).toMatchObject({ state: 'clear', ifStoppedHours: null, forecastProblem: 'no-rate' });
  });
});

describe('неизвестное не безопасно', () => {
  const files = [active(A, 1, 100, 1, 8 * MiB)];
  it.each([
    ['нет границы', { cursor: null }, 'no-cursor'],
    ['нет конца журнала', { tail: null }, 'no-tail'],
    ['нет притока', { rate: null }, 'no-rate'],
    ['нулевой приток', { rate: 0 }, 'no-inflow'],
    ['нет настроек', { config: null }, 'config'],
  ])('%s — unknown', (_n, over, reason) => {
    const r = computeRisk({ ...base, files, cursor: at(A, 50), tail: at(A, 100), ...over });
    expect(r).toMatchObject({ state: 'unknown', reason });
  });
});

describe('разбор заголовков и настроек', () => {
  const header = [
    'File path: /var/log/journal/m/system@4344c84b1b0440838637b50482582e2e-000000000047f1bd-00065fc7f4d70cae.journal',
    'File ID: d72d40a2ac454b5da40cb62504766623',
    'Sequential number ID: 4344c84b1b0440838637b50482582e2e',
    'State: ARCHIVED',
    'Head sequential number: 4714941 (47f1bd)',
    'Tail sequential number: 4766741 (48bc15)',
    'Head realtime timestamp: Sun 2026-11-08 18:24:31 UTC (65fc7f4d70cae)',
    'Tail realtime timestamp: Sun 2026-11-08 22:05:49 UTC (65fcb0c48d4eb)',
    'Entry objects: 49770',
    'Disk usage: 46.3M',
    '',
    'File path: /var/log/journal/m/system.journal',
    'Sequential number ID: 4344c84b1b0440838637b50482582e2e',
    'State: ONLINE',
    'Head sequential number: 0 (0)',
    'Tail sequential number: 0 (0)',
    'Head realtime timestamp: n/a',
    'Entry objects: 0',
  ].join('\n');

  it('заголовки systemd 255: номера, время, пустой активный файл', () => {
    const f = parseHeaders(header);
    expect(f).toHaveLength(2);
    expect(f[0]).toMatchObject({
      head: 4714941n,
      tail: 4766741n,
      entries: 49770,
      state: 'ARCHIVED',
    });
    expect(f[0].headRt).toBe(Number(0x65fc7f4d70caen));
    expect(f[1]).toMatchObject({ entries: 0, head: null });
  });

  it('неоднозначный заголовок — unknown, без оптимистичного расчёта', () => {
    const reasonOf = (text: string) => {
      try {
        parseHeaders(text);
        return 'разобран';
      } catch (e) {
        return (e as { reason?: string }).reason;
      }
    };
    // Номер и его шестнадцатеричная запись расходятся.
    expect(reasonOf(header.replace('4714941 (47f1bd)', '4714941 (47f1be)'))).toBe(
      'header-ambiguous',
    );
    // Поле повторено.
    expect(reasonOf(header.replace('State: ARCHIVED', 'State: ARCHIVED\nState: ONLINE'))).toBe(
      'header-ambiguous',
    );
    // Незнакомое состояние файла.
    expect(reasonOf(header.replace('State: ARCHIVED', 'State: WEIRD'))).toBe('header-ambiguous');
    expect(reasonOf('')).toBe('no-files');
  });

  it('настройки сервера: 4G, 15G, умолчания размера файла и числа файлов', () => {
    const c = parseJournaldConfig(
      '# /etc/systemd/journald.conf\n[Journal]\n#SystemMaxUse=\n# /etc/systemd/journald.conf.d/50-fifth.conf\n[Journal]\nStorage=persistent\nSystemMaxUse=4G\nSystemKeepFree=15G\n',
      119 * GiB,
    );
    expect(c).toMatchObject({
      maxUse: 4 * GiB,
      keepFree: 15 * GiB,
      fileMax: 128 * MiB,
      maxFiles: 100,
      retentionSec: 0,
    });
    const d = parseJournaldConfig(
      '[Journal]\nMaxRetentionSec=1month 2d\nSystemMaxUse=\n',
      10 * GiB,
    );
    expect(d.maxUse).toBe(GiB);
    expect(d.retentionSec).toBe(2629800 + 2 * 86400);
    expect(() => parseJournaldConfig('[Journal]\nStorage=volatile\n', GiB)).toThrow();
    expect(() => parseJournaldConfig('[Journal]\nSystemMaxUse=10%\n', GiB)).toThrow();
  });
});

describe('приток на диске', () => {
  it('первый замер — опорный; переименование при ротации не считается дважды; новый файл — целиком', () => {
    const t0 = trackGrowth(undefined, [{ ino: '1', size: 10 * MiB }], NOW - 2 * H);
    expect(t0.hours).toEqual({});
    const t1 = trackGrowth(
      t0,
      [
        { ino: '1', size: 18 * MiB },
        { ino: '2', size: 8 * MiB },
      ],
      NOW - 1.5 * H,
    );
    const hk = Math.floor((NOW - 1.5 * H) / H);
    expect(t1.hours[hk]).toBe(16 * MiB);
    // Полные часы замера: 10–11 (16 МиБ) и 11–12 (0) — среднее 8 МиБ/ч.
    const r = diskRate(t1, [], NOW);
    expect(r).toMatchObject({ rate: 8 * MiB, source: 'avg' });
  });

  it('сразу после выпуска — по закрытым файлам за 7 суток', () => {
    const t = trackGrowth(undefined, [], NOW);
    const files = [closed(A, 1, 10, 10, 48 * MiB), closed(A, 11, 20, 5, 48 * MiB)];
    // 96 МиБ за 5,5 ч (от начала первого до конца второго).
    const r = diskRate(t, files, NOW);
    expect(r.source).toBe('files');
    expect(r.rate).toBeCloseTo((96 * MiB) / 5.5, -3);
  });
});

describe('Zabbix', () => {
  const byKey = Object.fromEntries(LOGS_ITEMS.map((x: { key: string; js: string }) => [x.key, x]));
  const val = (key: string, risk: object) => {
    const s = {
      format: 'logs-metrics/v1',
      atEpoch: Math.floor(Date.now() / 1000),
      journald: { risk },
    };
    try {
      return runInNewContext(`(function (value) { ${byKey[key].js} })`, {})(JSON.stringify(s));
    } catch {
      return 'неизвестно';
    }
  };

  it('оценка — только в состоянии ok; unknown с отсрочкой и без', () => {
    expect(val('logs.journald.risk_hours', { state: 'ok', hours: 30 })).toBe(30);
    expect(val('logs.journald.risk_hours', { state: 'clear', hours: null })).toBe('неизвестно');
    expect(val('logs.journald.risk_state', { state: 'lost' })).toBe('lost');
    expect(val('logs.journald.risk_state', { state: 'safe' })).toBe('неизвестно');
    expect(
      val('logs.journald.risk_grace', { state: 'unknown', reason: 'config', grace: true }),
    ).toBe(1);
    expect(
      val('logs.journald.risk_reason', { state: 'unknown', reason: 'config', grace: false }),
    ).toBe('config');
  });

  it('тревоги: потеря, оценка < 48 ч при ok, неизвестное после отсрочки; прежней тревоги заполнения нет', () => {
    const t: [string, string, number][] = logsTriggers('h', 'f');
    const names = t.map(([n]) => n);
    expect(names).not.toContain('Журналы: journald заполнится меньше чем за 48 ч');
    expect(t.find(([n]) => n.includes('удалены'))?.[1]).toContain('risk_state)="lost"');
    expect(t.find(([n]) => n.includes('48 ч'))?.[1]).toContain('risk_state)="ok"');
    expect(t.find(([n]) => n.includes('не вычисляется'))?.[1]).toContain('risk_grace)=0');
    expect(LOGS_ITEMS.every((x: { js: string }) => !/=>|`|\blet\b|\bconst\b/.test(x.js))).toBe(
      true,
    );
  });
});
