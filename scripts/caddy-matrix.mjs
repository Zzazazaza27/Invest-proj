#!/usr/bin/env node
/**
 * Матрица контроля Caddy (план выпуска W31–W33, раздел 6): одинакова до и после применения
 * Caddyfile из Git; отличие — отказ шага.
 *
 *   node scripts/caddy-matrix.mjs <метка>             снять матрицу → out/release-w31/caddy-matrix-<метка>.json
 *   node scripts/caddy-matrix.mjs --compare <до> <после>
 *
 * Пароль test-1 — из .local/test-1-access.txt (не печатается). Для 5espace.com «с паролем» учётки
 * у Мауса нет: это покрывает веб-проверка Zabbix (учётка monitor), строка «Zabbix: открытые
 * проблемы» снимается шагом prod-monitoring-status.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'out/release-w31');
const file = (label) => join(OUT, `caddy-matrix-${label}.json`);

if (process.argv[2] === '--compare') {
  const [a, b] = [process.argv[3], process.argv[4]].map((l) =>
    JSON.parse(readFileSync(file(l), 'utf8')),
  );
  let bad = 0;
  for (const row of a.rows) {
    const other = b.rows.find((r) => r.name === row.name);
    const same = other && other.got === row.got;
    if (!same) bad += 1;
    console.log(
      `${same ? 'ok ' : 'РАЗНИЦА'} ${row.name}: ${row.got} → ${other?.got ?? 'нет строки'}`,
    );
  }
  console.log(bad ? `\nрасхождений: ${bad}` : '\nматрица совпадает');
  process.exit(bad ? 1 : 0);
}

const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/.test(label)) {
  console.error('нужна метка, например before | after');
  process.exit(2);
}

const access = readFileSync(join(ROOT, '.local/test-1-access.txt'), 'utf8');
const user = /логин\s+(\S+)/.exec(access)?.[1];
const pass = /пароль\s+(\S+)/.exec(access)?.[1];
const t1auth = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

async function req(url, { method = 'GET', headers = {} } = {}) {
  try {
    const r = await fetch(url, {
      method,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    await r.arrayBuffer().catch(() => null);
    return r;
  } catch (e) {
    return { status: `сбой ${e.cause?.code ?? e.name}`, headers: new Headers() };
  }
}

const key = `w31-matrix-${Date.now()}.bin`;
const rows = [];
const add = async (name, expect, fn) => {
  const got = String(await fn());
  rows.push({ name, expect, got, ok: got === expect });
};
const status = (url, o) => async () => (await req(url, o)).status;
const location = (url) => async () => {
  const r = await req(url);
  return `${r.status} ${r.headers.get('location') ?? ''}`.trim();
};
const cors = (url, origin) => async () => {
  const r = await req(url, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
  });
  return `${r.status} ${r.headers.get('access-control-allow-origin') ?? '-'}`;
};

await add('5espace.com / без пароля', '401', status('https://5espace.com/'));
await add(
  'www → корень с путём',
  '302 https://5espace.com/x?y',
  location('https://www.5espace.com/x?y'),
);
await add('mail → корень', '302 https://5espace.com/', location('https://mail.5espace.com/'));
await add(
  'panel / без пароля (на вход панели)',
  '302 /login/',
  location('https://panel.5espace.com/'),
);
await add('test-1 / без пароля', '401', status('https://test-1.5espace.com/'));
await add(
  'test-1 /v1/ready с паролем',
  '200',
  status('https://test-1.5espace.com/v1/ready', { headers: { Authorization: t1auth } }),
);
await add('test-2 / без пароля', '200', status('https://test-2.5espace.com/'));
await add('test-2 /v1/ready без пароля', '200', status('https://test-2.5espace.com/v1/ready'));
await add('files / GET', '404', status('https://files.5espace.com/'));
await add('files чтение объекта', '404', status(`https://files.5espace.com/fifth-element/${key}`));
for (const bucket of ['fifth-element', 'fifth-test-1', 'fifth-test-2']) {
  const own =
    bucket === 'fifth-element' ? 'https://5espace.com' : `https://${bucket.slice(6)}.5espace.com`;
  await add(
    `files ${bucket} OPTIONS свой Origin`,
    `204 ${own}`,
    cors(`https://files.5espace.com/${bucket}`, own),
  );
  await add(
    `files ${bucket} OPTIONS чужой Origin`,
    '403 -',
    cors(`https://files.5espace.com/${bucket}`, 'https://evil.example'),
  );
}
await add('files fifth-element POST без формы', 'не 200', async () => {
  const s = (await req('https://files.5espace.com/fifth-element', { method: 'POST' })).status;
  return s === 200 ? '200' : 'не 200';
});
await add('Zabbix: открытые проблемы (веб-проверка 5espace.com с паролем)', '0', () => {
  const r = spawnSync(
    'ssh',
    [
      '-i',
      join(homedir(), '.ssh', 'maus_5e'),
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'BatchMode=yes',
      'maus@193.233.217.210',
      'sudo -n /usr/local/sbin/fifth-test op prod-monitoring-status',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return /открытых проблем:?\s*(\d+)/.exec(r.stdout ?? '')?.[1] ?? `не прочитано (${r.status})`;
});

mkdirSync(OUT, { recursive: true });
writeFileSync(file(label), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
for (const r of rows)
  console.log(
    `${r.ok ? 'ok ' : 'НЕ ТАК'} ${r.name}: ${r.got}${r.ok ? '' : ` (ожидалось ${r.expect})`}`,
  );
console.log(`\nзаписано: ${file(label)}`);
