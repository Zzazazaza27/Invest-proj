#!/usr/bin/env node
/**
 * Подтверждение отключения учётки мониторинга — только ожидаемыми ответами
 * (scripts/lib/monitor-probe.mjs; замечание Тэнка 2026-11-02: 503 считался
 * «вход отклонён»).
 *
 *   node scripts/check-monitor-probe-disable.mjs
 */
import { loginDenialVerdict, sessionDenialVerdict } from './lib/monitor-probe.mjs';

const T = 'https://unicorn.local/problems';
const forbidden = { type: `${T}/forbidden`, title: 'Forbidden', status: 403 };
const stepUp = { type: `${T}/step_up_required`, status: 403 };
const unauth = { type: `${T}/unauthenticated`, status: 401 };

const cases = [
  [
    'вход 403 forbidden, база suspended — подтверждено',
    loginDenialVerdict(403, forbidden, 'suspended'),
    true,
  ],
  [
    'вход 403 forbidden, но база active — не подтверждено',
    loginDenialVerdict(403, forbidden, 'active'),
    false,
  ],
  [
    'вход 403 step_up_required — не блокировка',
    loginDenialVerdict(403, stepUp, 'suspended'),
    false,
  ],
  ['вход 403 без тела — не подтверждено', loginDenialVerdict(403, null, 'suspended'), false],
  [
    'вход 429 (ограничение частоты) — не подтверждено',
    loginDenialVerdict(429, null, 'suspended'),
    false,
  ],
  [
    'вход 503 (сервис недоступен) — не подтверждено',
    loginDenialVerdict(503, null, 'suspended'),
    false,
  ],
  ['вход 404 — не подтверждено', loginDenialVerdict(404, null, 'suspended'), false],
  [
    'вход 401 (неверный пароль) — не подтверждено',
    loginDenialVerdict(401, unauth, 'suspended'),
    false,
  ],
  ['вход 200 — не подтверждено', loginDenialVerdict(200, {}, 'suspended'), false],
  ['сессия 401 unauthenticated — подтверждено', sessionDenialVerdict(401, unauth), true],
  ['сессия 503 — не подтверждено', sessionDenialVerdict(503, null), false],
  ['сессия 429 — не подтверждено', sessionDenialVerdict(429, null), false],
  ['сессия 401 без тела — не подтверждено', sessionDenialVerdict(401, null), false],
  ['сессия 200 — не подтверждено', sessionDenialVerdict(200, {}), false],
];

let failed = 0;
for (const [name, v, expected] of cases) {
  const ok = v.ok === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${v.reason}`);
}
console.log(`\n${cases.length - failed}/${cases.length}`);
process.exit(failed ? 1 : 0);
