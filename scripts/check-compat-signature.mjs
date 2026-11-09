#!/usr/bin/env node
/**
 * Происхождение отчёта совместимости (scripts/lib/compat-report.mjs) — без Docker.
 * Тэнк 09.11: отчёт — основание точки возврата, только если подписан CI (вся запись) и
 * проверяется закреплённым ключом узла; хеши комплектов связывают его с образами.
 *
 * Запуск: node scripts/check-compat-signature.mjs
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCompatReport } from './lib/compat-report.mjs';
import { signCompat, signKit } from './lib/kit-sign.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const pem = () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    priv: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pub: publicKey.export({ type: 'spki', format: 'pem' }),
  };
};
const ci = pem();
const stranger = pem();
const dir = mkdtempSync(join(tmpdir(), 'fifth-compat-sig-'));
const kitsDir = join(dir, 'kits');
const etcDir = join(dir, 'etc');
mkdirSync(join(kitsDir, 'b2'), { recursive: true });
mkdirSync(etcDir);
writeFileSync(join(etcDir, 'kit-signing.pub'), ci.pub);
const sha = { b1: 'aaa', b2: 'bbb' };
const kitSha = (b) => sha[b];
const file = join(kitsDir, 'b2', 'compat-b1.json');
const write = (report, signer) => {
  const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(file, bytes);
  rmSync(`${file}.sig`, { force: true });
  if (signer) writeFileSync(`${file}.sig`, `${signer(bytes)}\n`);
  return bytes;
};
const read = () => readCompatReport({ kitsDir, etcDir, candidate: 'b2', previous: 'b1', kitSha });
const good = {
  result: 'ok',
  previous: { build: 'b1', kitSha256: 'aaa' },
  candidate: { build: 'b2', kitSha256: 'bbb' },
  newMigrations: ['M171_x'],
  tools: { commit: 'c0ffee' },
};

console.warn('\n=== ПРОИСХОЖДЕНИЕ ОТЧЁТА СОВМЕСТИМОСТИ ===\n');
try {
  write(good, (b) => signCompat(b, ci.priv));
  check('подписан CI, пара совпадает — принят', read()?.result === 'ok');

  write(good, null);
  check('без подписи — не основание', read()?.result === 'unsigned', read()?.detail);

  const bytes = write(good, (b) => signCompat(b, ci.priv));
  writeFileSync(file, Buffer.from(bytes.toString('utf8').replace('"ok"', '"ok" ')));
  check('содержимое изменено после подписи — отклонён', read()?.result === 'bad-signature');

  write(good, (b) => signCompat(b, stranger.priv));
  check('подписан чужим ключом — отклонён', read()?.result === 'bad-signature');

  write(good, (b) => signKit(b, ci.priv));
  check('подпись комплекта вместо подписи отчёта — отклонён', read()?.result === 'bad-signature');

  write({ ...good, previous: { build: 'b1', kitSha256: 'другой' } }, (b) => signCompat(b, ci.priv));
  check('подписан, но о другой паре комплектов — stale', read()?.result === 'stale');

  write(good, (b) => signCompat(b, ci.priv));
  rmSync(join(etcDir, 'kit-signing.pub'));
  check(
    'на узле нет закреплённого ключа — не основание',
    read()?.result === 'unsigned',
    read()?.detail,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено.\n`);
if (failed > 0) process.exitCode = 1;
