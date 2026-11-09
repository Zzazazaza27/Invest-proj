#!/usr/bin/env node
/**
 * Происхождение отчёта совместимости (scripts/lib/compat-report.mjs) — без Docker.
 * Тэнк 09.11: отчёт — основание точки возврата, только если подписан CI (вся запись) и
 * проверяется закреплённым ключом узла; хеши комплектов связывают его с образами.
 *
 * Запуск: node scripts/check-compat-signature.mjs
 */
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCompatReport } from './lib/compat-report.mjs';
import { signCompat, signKit } from './lib/kit-sign.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

  // Доставка на узел: kit.mjs compat-put из каталога артефактов.
  const art = join(dir, 'artifacts');
  mkdirSync(art);
  writeFileSync(join(kitsDir, 'b2', 'kit.json'), JSON.stringify({ build: 'b2' }));
  const put = (report, signer) => {
    rmSync(join(art, 'compat-b1.json.sig'), { force: true });
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
    writeFileSync(join(art, 'compat-b1.json'), bytes);
    if (signer) writeFileSync(join(art, 'compat-b1.json.sig'), signer(bytes));
    const r = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'kit.mjs'), 'compat-put', '--build', '2.1-b2.1', '--dir', art],
      {
        encoding: 'utf8',
        env: { ...process.env, FIFTH_KITS_DIR: kitsDir, FIFTH_INSTALL_ETC: etcDir },
      },
    );
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  mkdirSync(join(kitsDir, '2.1-b2.1'));
  writeFileSync(join(kitsDir, '2.1-b2.1', 'kit.json'), JSON.stringify({ build: '2.1-b2.1' }));
  const forCand = { ...good, candidate: { build: '2.1-b2.1', kitSha256: 'bbb' } };
  check(
    'доставка: подписанный отчёт принят',
    put(forCand, (b) => signCompat(b, ci.priv)).code === 0,
  );
  check('доставка: без подписи — отказ', put(forCand, null).code === 2);
  check(
    'доставка: подпись чужим ключом — отказ',
    put(forCand, (b) => signCompat(b, stranger.priv)).code === 2,
  );
  check(
    'доставка: отчёт о другом кандидате — отказ',
    put(good, (b) => signCompat(b, ci.priv)).code === 2,
  );

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
