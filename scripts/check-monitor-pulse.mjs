#!/usr/bin/env node
/**
 * Свежесть контрольной отметки Zabbix для пульса (2.1-W08a; замечание Тэнка
 * 2026-11-02): отметка из будущего, пустое и неверное время — отказ.
 *
 *   node scripts/check-monitor-pulse.mjs
 */
import { pulseVerdict } from './lib/pulse.mjs';

const NOW = 1_800_000_000;
const FRESH = 180;
const cases = [
  ['свежая отметка 10 с назад', NOW - 10, true],
  ['ровно на пороге', NOW - FRESH, true],
  ['малое расхождение часов (30 с вперёд)', NOW + 30, true],
  ['устарела', NOW - FRESH - 1, false],
  ['из будущего на час', NOW + 3600, false],
  ['из будущего сверх допуска', NOW + 61, false],
  ['нет времени (null)', null, false],
  ['пустая строка', '', false],
  ['ноль (Zabbix: значений не было)', '0', false],
  ['не число', 'abc', false],
  ['дробное', String(NOW - 10.5), false],
  ['строка-число (как отдаёт API)', String(NOW - 10), true],
];

let failed = 0;
for (const [name, clock, expected] of cases) {
  const v = pulseVerdict(clock, NOW, FRESH);
  const ok = v.ok === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${v.reason}`);
}
console.log(`\n${cases.length - failed}/${cases.length}`);
process.exit(failed ? 1 : 0);
