#!/usr/bin/env node
/**
 * Правило допустимости возврата (scripts/lib/rollback-policy.mjs) — без Docker и баз.
 *
 * Узкая регрессия к замечанию Тэнка 09.11: отметка точки возврата при установке и решение о
 * возврате — одно правило. Новая contract-миграция при пройденном отчёте совместимости —
 * «не проверена» и запрет, а не «проверена». Сценарий установщика целиком — check-release.
 *
 * Запуск: node scripts/check-rollback-policy.mjs
 */
import { rollbackVerdict } from './lib/rollback-policy.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const kit = (...migrations) => ({ migrations });
const plain = { id: 'M171_add', contract: false };
const contract = { id: 'M172_drop', contract: true };
const ok = (...ids) => ({ result: 'ok', newMigrations: ids });

console.warn('\n=== ПРАВИЛО ВОЗВРАТА ===\n');
{
  const v = rollbackVerdict(kit(plain), [], null);
  check('незнакомых миграций нет — разрешён', v.allowed, v.reason);
}
{
  const v = rollbackVerdict(kit(plain), ['M171_add'], null);
  check('без отчёта — не разрешён', !v.allowed && !v.forbidden, v.reason);
}
for (const result of ['failed', 'stale']) {
  const v = rollbackVerdict(kit(plain), ['M171_add'], { result, newMigrations: ['M171_add'] });
  check(`отчёт «${result}» — не разрешён`, !v.allowed, v.reason);
}
{
  const v = rollbackVerdict(
    kit(plain, { id: 'M173_more' }),
    ['M171_add', 'M173_more'],
    ok('M171_add'),
  );
  check('отчёт покрывает не все незнакомые — не разрешён', !v.allowed, v.reason);
}
{
  const v = rollbackVerdict(kit(plain), ['M171_add'], ok('M171_add'));
  check('пройденный отчёт, покрывающий все, — разрешён', v.allowed, v.reason);
}
{
  // Замечание Тэнка: новая contract-миграция + отчёт ok — запрет, не «проверена».
  const v = rollbackVerdict(
    kit(plain, contract),
    ['M171_add', 'M172_drop'],
    ok('M171_add', 'M172_drop'),
  );
  check(
    'contract-миграция при пройденном отчёте — запрет',
    !v.allowed && v.forbidden && /M172_drop/.test(v.reason),
    v.reason,
  );
}
{
  // Contract-миграция, известная целевому комплекту, запрета не даёт: её нет среди незнакомых.
  const v = rollbackVerdict(kit(contract, plain), ['M171_add'], ok('M171_add'));
  check('contract, уже известная целевому, не мешает', v.allowed, v.reason);
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
