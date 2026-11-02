import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { createShutdown, shutdownLog } from '../src/background/shutdown';
import { JsonLogger } from '../src/common/logging/json-logger';
import { safeError, safeFields, sanitizeText } from '../src/common/logging/safe-log';

/**
 * Технический журнал без секретов до первой записи (блок 8, 8.4; 2.1-W08b).
 * Искусственные значения CANARY-* не должны дожить до строки журнала ни в
 * одной форме: текст библиотеки, поле вызова, исключение, стек.
 */
const C = 'CANARY-W08B';

function capture(): { logger: JsonLogger; lines: string[] } {
  const lines: string[] = [];
  const logger = new JsonLogger(
    { component: 'core', env: 'test', instance: 'h:1', version: 'abc1234' },
    new Set(['error', 'warn', 'log', 'fatal']),
    (_stream, line) => lines.push(line),
  );
  return { logger, lines };
}

describe('Маскировка текста', () => {
  const cases: Array<[string, string]> = [
    ['адрес с паролем', `connect postgres://app:${C}-pw@db:5432/x failed`],
    ['query в пути', `GET /v1/auth/email/verify/status?token=${C}-q`],
    ['Bearer', `Authorization: Bearer ${C}-bearer`],
    ['JWT', `token eyJhbGciOi.eyJzdWIiOi${C}.c2lnbmF0dXJl`],
    ['пара password=', `password=${C}-pass and more`],
    ['пара в JSON', `{"cookie":"sid=${C}-cookie"}`],
    ['PostgreSQL Key', `Key (email_hmac)=(${C}-key) already exists`],
    ['значение в кавычках', `invalid input syntax for type uuid: "${C}-uuid"`],
    ['одинарные кавычки', `SELECT length('${C}-lit') / 0`],
    ['почта', `письмо для ${C.toLowerCase()}@example.com не ушло`],
  ];
  for (const [name, text] of cases) {
    it(name, () => {
      expect(sanitizeText(text)).not.toContain(C);
      expect(sanitizeText(text).toLowerCase()).not.toContain(C.toLowerCase());
    });
  }

  it('управляющие символы не разрывают строку', () => {
    expect(sanitizeText('a\nb\r\u0000c')).toBe('a b  c');
  });

  it('обычный текст остаётся читаемым', () => {
    expect(sanitizeText('фоновые задачи не запускаются: нет блокировки')).toBe(
      'фоновые задачи не запускаются: нет блокировки',
    );
  });
});

describe('Поля записи — по перечню', () => {
  it('неизвестные поля не пишутся, их имена видны', () => {
    const out = safeFields({ msg: 'x', key: `${C}-hmac`, file: `${C}.eml`, path: `/a?t=${C}` });
    expect(JSON.stringify(out)).not.toContain(C);
    expect(out.dropped).toEqual(['key', 'file', 'path']);
  });

  it('пустые поля не пишутся и не считаются отброшенными', () => {
    expect(safeFields({ msg: 'x', internal: undefined, code: undefined })).toEqual({ msg: 'x' });
  });

  it('traceId → requestId, internal поднимается по перечню', () => {
    const out = safeFields({
      traceId: 'r-1',
      internal: { stage: 'no-user', secretThing: C },
    });
    expect(out).toMatchObject({ requestId: 'r-1', stage: 'no-user', dropped: ['secretThing'] });
  });

  it('прежняя форма error { message, stack } — без текста', () => {
    const err = new Error(`duplicate key (${C})`);
    const out = safeFields({ error: { message: err.message, stack: err.stack } });
    expect(JSON.stringify(out)).not.toContain(C);
    expect(Array.isArray(out.frames)).toBe(true);
  });
});

describe('Исключение', () => {
  it('класс и SQLSTATE, без текста ни в сообщении, ни в стеке', () => {
    const err = Object.assign(new Error(`invalid input syntax: "${C}"`), { code: '22P02' });
    const out = safeError(err);
    expect(out.errorName).toBe('Error');
    expect(out.sqlstate).toBe('22P02');
    expect(JSON.stringify(out)).not.toContain(C);
  });
});

describe('JsonLogger', () => {
  it('строка Nest с контекстом и стеком', () => {
    const { logger, lines } = capture();
    const err = new Error(`boom ${C}`);
    // Текст с признаками секрета маскируется; подстановку произвольного
    // значения в текст запрещает сторож ниже — её маскировка не распознает.
    logger.error(`ошибка: token=${C}-msg`, err.stack, 'ctx');
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      level: 'error',
      ctx: 'ctx',
      component: 'core',
      version: 'abc1234',
    });
    expect(lines[0]).not.toContain(C);
  });

  it('объект вызова и исключение первым аргументом', () => {
    const { logger, lines } = capture();
    logger.warn({ msg: 'учёт', key: C, error: `redis: ERR "${C}"` }, 'login');
    logger.error(new Error(`pg: ${C}`));
    expect(lines.join('\n')).not.toContain(C);
    expect(JSON.parse(lines[1]!).errorName).toBe('Error');
  });

  it('уровень вне набора не пишется', () => {
    const { logger, lines } = capture();
    logger.debug('подробно');
    expect(lines).toHaveLength(0);
  });
});

/**
 * Сторож исходников. Во время работы произвольную строку от кода по формату
 * не отличить (`CANARY_UNLABELLED_7284` выглядит как код ошибки), поэтому
 * путь значения проверяется на месте вызова:
 *  - подстановка в ТЕКСТ любого вызова журнала (logger.…, options.log, log:
 *    …) — только из утверждённого перечня: настройки, константы, счётчики;
 *  - в полях объектного вызова нет текста ошибок: `.message`, `.stack`,
 *    `String(…)`, `JSON.stringify`, `toString()`; подстановки — из перечня;
 *  - поле `error` — только сам объект исключения (имя переменной).
 * Обход 1 Тэнка (завершение процесса) шёл через options.log — первое правило
 * его ловит; обход 2 (строка в поле error) — второе и третье.
 */
const APPROVED = new Set([
  'EVENT_STREAM',
  'env.NODE_ENV',
  'env.CORE_BIND_HOST',
  'env.CORE_PORT',
  'env.AUTH_MODE',
  'env.CORE_ROLE',
  'env.CORE_INTERNAL_BIND_HOST',
  'internal.port',
  'background.reason',
  'created',
  'removed',
  'signal',
  'options.graceMs',
  'target.host',
  'target.port',
  'e.def.name',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Тело объектного литерала после открывающей скобки, с учётом вложенности. */
function objectBody(s: string, from: number): string {
  let depth = 1;
  let j = from;
  while (depth && j < s.length) {
    if (s[j] === '{') depth++;
    else if (s[j] === '}') depth--;
    j++;
  }
  return s.slice(from, j - 1);
}

/** Пары «ключ: значение» верхнего уровня (сокращённая запись — ключ сам). */
function topLevel(body: string): Array<[string, string]> {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let quote: string | null = null;
  for (const ch of body.replace(/\/\/.*$/gm, '')) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/);
      return m ? [m[1]!, m[2]!.trim()] : [p, p];
    });
}

function unapprovedSubs(template: string): string[] {
  return [...template.matchAll(/\$\{([^}]*)\}/g)]
    .map((m) => m[1]!.trim())
    .filter((e) => !APPROVED.has(e));
}

function guardFindings(srcDir: string): string[] {
  const found: string[] = [];
  for (const f of sourceFiles(srcDir)) {
    const s = readFileSync(f, 'utf8');
    const where = (i: number) =>
      `${f.split(/[\\/]/).slice(-2).join('/')}:${s.slice(0, i).split('\n').length}`;
    // 1. Подстановки в текст любого вызова журнала.
    for (const re of [
      /\b(?:log|warn|error|info|debug|verbose|fatal)\(\s*`([^`]*)`/g,
      /msg:\s*`([^`]*)`/g,
    ]) {
      for (const m of s.matchAll(re)) {
        for (const e of unapprovedSubs(m[1]!)) found.push(`${where(m.index!)} текст: \${${e}}`);
      }
    }
    // 2–3. Поля объектных вызовов журнала.
    for (const m of s.matchAll(/logger\.(?:log|warn|error|debug|verbose|fatal)\(\{/g)) {
      for (const [key, value] of topLevel(objectBody(s, m.index! + m[0].length))) {
        if (/\.message\b|\.stack\b|\bString\(|JSON\.stringify|\.toString\(/.test(value)) {
          found.push(`${where(m.index!)} поле ${key}: текст ошибки`);
        }
        if (value.startsWith('`')) {
          for (const e of unapprovedSubs(value))
            found.push(`${where(m.index!)} поле ${key}: \${${e}}`);
        }
        if (key === 'error' && !/^[A-Za-z_]\w*$/.test(value)) {
          found.push(`${where(m.index!)} поле error: не объект исключения`);
        }
      }
    }
  }
  return found;
}

describe('Сторож исходников журнала', () => {
  it('в ядре нет текста ошибок и неутверждённых подстановок', () => {
    // LOG_GUARD_SRC — проверить сторожем другой срез исходников (контрольный прогон).
    expect(guardFindings(process.env.LOG_GUARD_SRC ?? join(__dirname, '..', 'src'))).toEqual([]);
  });
});

/**
 * Обходы, найденные Тэнком 2026-11-02 (воспроизведены на f76f5de):
 * 1) завершение процесса вставляло текст исключения в строку сообщения;
 * 2) ошибка, заранее превращённая в строку, проходила по разрешённому имени
 *    поля `error`.
 */
const U = 'CANARY_UNLABELLED_7284';

describe('Обход 1: завершение процесса — полный путь', () => {
  it('исключение закрывающей функции не попадает в журнал текстом', async () => {
    const { logger: json, lines } = capture();
    // Как в main.ts: Logger('bootstrap') Nest → JsonLogger, связка shutdownLog.
    Logger.overrideLogger(json);
    try {
      const exits: number[] = [];
      const shutdown = createShutdown({
        jobs: { stop: async () => 0 },
        closers: [
          async () => {
            throw new Error(U);
          },
        ],
        graceMs: 1_000,
        exit: (code) => exits.push(code),
        log: shutdownLog(new Logger('bootstrap')),
      });
      await shutdown('SIGTERM');
      expect(exits).toEqual([0]);
      expect(lines.join('\n')).not.toContain(U);
      const rec = lines.map((l) => JSON.parse(l)).find((r) => r.msg === 'ошибка при закрытии');
      expect(rec).toMatchObject({ ctx: 'bootstrap', errorName: 'Error' });
    } finally {
      Logger.overrideLogger(new ConsoleLogger());
    }
  });
});

describe('Обход 2: ошибка строкой', () => {
  it('safeFields не пишет строку в поле error, видно, что она была', () => {
    const out = safeFields({ error: U });
    expect(JSON.stringify(out)).not.toContain(U);
    expect(out.dropped).toEqual(['error(текст)']);
  });
  it('JsonLogger не пишет строку в поле error', () => {
    const { logger, lines } = capture();
    logger.warn({ msg: 'отказ', error: U });
    expect(lines.join('\n')).not.toContain(U);
  });
});
