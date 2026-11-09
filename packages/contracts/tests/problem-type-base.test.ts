import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErrorCode, PROBLEM_TYPE_BASE } from '../src';

/**
 * Блок 13: `type` ошибки — постоянный идентификатор. Ответы, которые отдаёт не ядро
 * (nginx, Caddy при недоступности), пишут его строкой: она должна совпадать с константой.
 */
const ROOT = join(__dirname, '..', '..', '..');
const FILES = ['infra/nginx/default.conf', 'infra/caddy/unavailable.caddy'];
const KNOWN = new Set(Object.values(ErrorCode) as string[]);

describe('идентификатор вида ошибки вне ядра', () => {
  for (const file of FILES) {
    it(`${file}: тот же префикс и известный код`, () => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const types = [...text.matchAll(/"type":"([^"]+)"/g)].map((m) => m[1]!);
      expect(types.length).toBeGreaterThan(0);
      for (const t of types) {
        expect(t.startsWith(`${PROBLEM_TYPE_BASE}/`)).toBe(true);
        expect(KNOWN.has(t.slice(PROBLEM_TYPE_BASE.length + 1))).toBe(true);
      }
    });
  }
});
