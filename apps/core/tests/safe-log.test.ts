import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
 * Сторож: подстановка значения в ТЕКСТ сообщения журнала маскировкой не
 * ловится (у произвольного значения нет признаков секрета). Поэтому каждая
 * подстановка — из утверждённого перечня: настройки, константы, счётчики.
 * Данные — только полями вызова, они идут через перечень safe-log.
 */
describe('Сторож: подстановки в текст журнала', () => {
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
  ]);
  const files: string[] = [];
  (function walk(d: string) {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (p.endsWith('.ts')) files.push(p);
    }
  })(join(__dirname, '..', 'src'));

  it('в ядре нет неутверждённых подстановок', () => {
    const found: string[] = [];
    const patterns = [
      /logger\.(?:log|warn|error|debug|verbose|fatal)\(\s*`([^`]*)`/g,
      /msg:\s*`([^`]*)`/g,
    ];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      for (const re of patterns) {
        for (const m of s.matchAll(re)) {
          for (const sub of m[1]!.matchAll(/\$\{([^}]*)\}/g)) {
            if (!APPROVED.has(sub[1]!.trim())) found.push(`${f}: \${${sub[1]}}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
