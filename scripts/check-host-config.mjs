#!/usr/bin/env node
/**
 * Съём действующей конфигурации узла (работа № 5 раздела 01): разбор и классы без узла, затем
 * съём на искусственном узле в контейнере — systemctl и docker там заменены ответами-образцами.
 *
 *   node scripts/check-host-config.mjs
 *
 * Проверяет: импорты Caddy (файлы, шаблоны, фрагменты), drop-in и EnvironmentFile юнитов,
 * файлы и монтирования Compose по меткам, замыкание по ссылкам, секреты по пути и по
 * содержимому — только в зашифрованную часть, Static seal key — не берётся вовсе.
 * Отчёт — out/host-config/<время>.json.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absPathsIn,
  caddyConfigPath,
  caddyImports,
  caddySiteNames,
  classifyPath,
  composeProjects,
  looksSecret,
  parseSystemdShow,
  relPathsIn,
} from './lib/host-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.HOST_CONFIG_IMAGE || 'fifth/core:faults';
const results = [];
const check = (name, ok, details = '') => {
  results.push({ name, ok: Boolean(ok), details: String(details).slice(0, 600) });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details && !ok ? ` — ${details}` : ''}`);
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

console.log('▸ разбор без узла');
check('класс: TLS узла — секрет', classifyPath('/etc/fifth-tls/services/ca.crt') === 'secret');
check('класс: .env — секрет', classifyPath('/opt/fifth-element/.env') === 'secret');
check(
  'класс: compose.env среды — секрет',
  classifyPath('/opt/fifth-element/.local/envs/prod/compose.env') === 'secret',
);
check(
  'класс: Static seal key — хранится отдельно',
  classifyPath('/etc/fifth-openbao/seal/static.key') === 'separate',
);
check(
  'класс: /run — создаётся службой',
  classifyPath('/run/fifth-secrets/DATABASE_URL') === 'runtime',
);
check('класс: копии — данные', classifyPath('/var/backups/fifth-element/sets') === 'data');
check('класс: Caddyfile — конфигурация', classifyPath('/etc/caddy/Caddyfile') === 'config');
check('содержимое: закрытый ключ — секрет', looksSecret('x\n-----BEGIN PRIVATE KEY-----\nabc'));
check(
  'содержимое: PASSWORD=значение — секрет',
  looksSecret('POSTGRES_PASSWORD=Zx9-very-real-value'),
);
check('содержимое: адрес с паролем — секрет', looksSecret('url: postgres://u:p4ss@db:5432/x'));
check(
  'содержимое: _FILE, пустое и подстановка — не секрет',
  !looksSecret('POSTGRES_PASSWORD_FILE=/run/x\nAPI_KEY=\nTOKEN=${TOKEN}\nSECRET=<секрет>'),
);
const caddy = [
  '{',
  '  email ops@example.org',
  '}',
  '(common) {',
  '  encode gzip',
  '}',
  'import sites/*.caddy',
  'import /etc/caddy/files.caddy',
  'import common',
  '5espace.com, www.5espace.com {',
  '  import common',
  '  reverse_proxy 127.0.0.1:4300',
  '}',
  'test-1.5espace.com {',
  '  respond 200',
  '}',
].join('\n');
check(
  'Caddy: импорт файлов и шаблонов, фрагмент — не файл',
  same(caddyImports(caddy, '/etc/caddy'), ['/etc/caddy/sites/*.caddy', '/etc/caddy/files.caddy']),
  JSON.stringify(caddyImports(caddy, '/etc/caddy')),
);
check(
  'Caddy: имена сайтов',
  same(caddySiteNames(caddy), ['5espace.com', 'www.5espace.com', 'test-1.5espace.com']),
  JSON.stringify(caddySiteNames(caddy)),
);
check(
  'Caddy: файл из ExecStart',
  caddyConfigPath(
    '{ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Main.caddy ; }',
  ) === '/etc/caddy/Main.caddy' && caddyConfigPath('') === '/etc/caddy/Caddyfile',
);
const show = parseSystemdShow(
  [
    'Id=fifth-x.service',
    'FragmentPath=/etc/systemd/system/fifth-x.service',
    'DropInPaths=/etc/systemd/system/fifth-x.service.d/a.conf /etc/systemd/system/fifth-x.service.d/b.conf',
    'EnvironmentFiles=/etc/fifth-x.env (ignore_errors=no)',
    'UnitFileState=enabled',
    'ActiveState=active',
    '',
    'Id=ssh.service',
    'FragmentPath=/usr/lib/systemd/system/ssh.service',
    'DropInPaths=',
    'UnitFileState=enabled',
    '',
  ].join('\n'),
);
check(
  'systemd: drop-in и EnvironmentFile',
  show[0].dropIns.length === 2 && same(show[0].environmentFiles, ['/etc/fifth-x.env']),
  JSON.stringify(show[0]),
);
const projects = composeProjects([
  {
    Name: '/fifth-core',
    Image: 'sha256:aaa',
    Config: {
      Image: 'fifth/core:2.1-b9',
      Labels: {
        'com.docker.compose.project': 'fifth',
        'com.docker.compose.service': 'core',
        'com.docker.compose.project.working_dir': '/opt/fifth-element/infra',
        'com.docker.compose.project.config_files': '/opt/fifth-element/infra/a.yml,/opt/x/b.yml',
        'com.docker.compose.project.environment_file': '/opt/fifth-element/.env',
      },
    },
    State: { Status: 'running' },
    Mounts: [
      { Type: 'bind', Source: '/etc/fifth-tls/services' },
      { Type: 'volume', Name: 'fifth_pg', Destination: '/var/lib/postgresql/data' },
    ],
  },
  {
    Name: '/run-once',
    Image: 'sha256:b',
    Config: {
      Labels: { 'com.docker.compose.project': 'fifth', 'com.docker.compose.oneoff': 'True' },
    },
  },
]);
check(
  'Compose: файлы, переменные, монтирования по меткам; разовые контейнеры не в счёт',
  projects.fifth.configFiles.length === 2 &&
    projects.fifth.envFiles[0] === '/opt/fifth-element/.env' &&
    Object.keys(projects.fifth.services).length === 1 &&
    projects.fifth.services.core.binds[0] === '/etc/fifth-tls/services',
);
check(
  'ссылки: абсолютные — только из мест конфигурации, относительные — от каталога',
  same(absPathsIn('x /etc/a.conf y /home/u/z /opt/q/r.yml, /tmp/w'), [
    '/etc/a.conf',
    '/opt/q/r.yml',
  ]) &&
    same(relPathsIn('volumes: [./nats.conf:/n, ../tls/ca.crt:/c]', '/opt/p/infra'), [
      '/opt/p/infra/nats.conf',
      '/opt/p/tls/ca.crt',
    ]),
);

// ------------------------------------------------- съём на искусственном узле
console.log('▸ съём на искусственном узле (контейнер)');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const fx = join(ROOT, '.local', 'check-host-config', stamp);
const put = (p, text, mode) => {
  const f = join(fx, 'tree', p);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text, mode ? { mode } : undefined);
};
put('etc/caddy/Caddyfile', caddy.replace('import /etc/caddy/files.caddy', 'import files.caddy'));
put(
  'etc/caddy/sites/a.caddy',
  'a.5espace.com {\n  tls { client_auth { trusted_ca_cert_file /etc/fifth-tls/services/ca.crt } }\n}\n',
);
put('etc/caddy/files.caddy', 'files.5espace.com {\n  reverse_proxy 127.0.0.1:3900\n}\n');
put(
  'etc/fifth-tls/services/ca.crt',
  '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----\n',
);
put('etc/fifth-tls/services/key.pem', '-----BEGIN PRIVATE KEY-----\nBBB\n');
put('etc/fifth-openbao/seal/static.key', 'SEAL-MUST-NOT-BE-TAKEN');
// выдуманное значение проверки: съём не должен его взять.
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
put('etc/fifth-openbao/approle/prod-core/secret-id', 'APPROLE-SECRET');
put(
  'etc/systemd/system/fifth-x.service',
  '[Service]\nEnvironmentFile=/etc/fifth-x.env\nExecStart=/usr/local/sbin/fifth-diag run\n',
);
put('etc/systemd/system/fifth-x.service.d/override.conf', '[Service]\nNice=5\n');
put('etc/fifth-x.env', 'MONITOR_TOKEN=abcdefgh12345678\n');
put('etc/leaky.conf', 'db_password = RealValue-1234567\n');
put('etc/docker/daemon.json', '{"log-driver":"journald"}\n');
put('usr/local/sbin/fifth-diag', '#!/bin/sh\ncat /etc/leaky.conf\n', 0o755);
put(
  'opt/fifth-element/infra/docker-compose.yml',
  'services:\n  nats:\n    volumes: [./nats.conf:/etc/nats.conf:ro, /etc/fifth-tls/services:/tls:ro]\n',
);
put('opt/fifth-element/infra/nats.conf', 'port: 4222\n');
put('opt/fifth-element/.env', 'POSTGRES_PASSWORD=very-secret-value-123\n');
const inspect = [
  {
    Name: '/fifth-nats',
    Image: 'sha256:1111',
    Config: {
      Image: 'nats:2.10-alpine',
      Labels: {
        'com.docker.compose.project': 'fifth',
        'com.docker.compose.service': 'nats',
        'com.docker.compose.project.working_dir': '/opt/fifth-element/infra',
        'com.docker.compose.project.config_files': '/opt/fifth-element/infra/docker-compose.yml',
        'com.docker.compose.project.environment_file': '/opt/fifth-element/.env',
      },
    },
    State: { Status: 'running' },
    Mounts: [
      { Type: 'bind', Source: '/opt/fifth-element/infra/nats.conf' },
      { Type: 'bind', Source: '/etc/fifth-tls/services' },
      { Type: 'bind', Source: '/run/fifth-secrets' },
    ],
  },
];
put('fx/inspect.json', JSON.stringify(inspect));
put(
  'fx/show.txt',
  [
    'Id=fifth-x.service',
    'FragmentPath=/etc/systemd/system/fifth-x.service',
    'DropInPaths=/etc/systemd/system/fifth-x.service.d/override.conf',
    'EnvironmentFiles=/etc/fifth-x.env (ignore_errors=no)',
    'UnitFileState=enabled',
    'ActiveState=active',
    'Type=simple',
    '',
    'Id=caddy.service',
    'FragmentPath=/usr/lib/systemd/system/caddy.service',
    'DropInPaths=/etc/systemd/system/caddy.service.d/limits.conf',
    'ExecStart={ path=/usr/bin/caddy ; argv[]=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile ; }',
    'UnitFileState=enabled',
    'ActiveState=active',
    '',
  ].join('\n'),
);
put('etc/systemd/system/caddy.service.d/limits.conf', '[Service]\nLimitNOFILE=1048576\n');
// Заменители команд узла: отвечают образцами, ничего не делают.
put(
  'usr/local/bin/systemctl',
  [
    '#!/bin/sh',
    'case "$1" in',
    '  list-unit-files) printf "fifth-x.service enabled enabled\\ncaddy.service enabled enabled\\nssh.service enabled enabled\\n" ;;',
    '  list-units) : ;;',
    '  show) cat /fx/show.txt ;;',
    'esac',
  ].join('\n'),
  0o755,
);
put(
  'usr/local/bin/docker',
  [
    '#!/bin/sh',
    'case "$1 $2" in',
    '  "ps -aq") echo abc ;;',
    '  "inspect abc") cat /fx/inspect.json ;;',
    '  "image inspect") echo \'["nats:2.10-alpine"]|[]|1000\' ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n'),
  0o755,
);
const runner = [
  "import { captureHost } from '/w/scripts/lib/host-config.mjs';",
  "const r = captureHost({ root: '/opt/fifth-element', outDir: '/out' });",
  'console.log(JSON.stringify({ secretPaths: r.secretPaths, host: r.host }));',
].join('\n');
put('fx/run.mjs', runner);
const r = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0',
    '-v',
    `${join(fx, 'tree')}:/seed:ro`,
    '-v',
    `${join(ROOT, 'scripts')}:/w/scripts:ro`,
    '--entrypoint',
    'sh',
    IMAGE,
    '-c',
    'cp -a /seed/. / && chmod 755 /usr/local/sbin/fifth-diag /usr/local/bin/systemctl /usr/local/bin/docker && mkdir -p /out && node /fx/run.mjs && echo "---" && find /out/files -type f | sort',
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
check('съём отработал', r.status === 0, (r.stderr || '').trim().split('\n').slice(-3).join(' | '));
if (r.status === 0) {
  const [json, list] = r.stdout.split('\n---\n');
  const { secretPaths, host } = JSON.parse(json.trim().split('\n').pop());
  const open = list
    .trim()
    .split('\n')
    .map((p) => p.replace(/^\/out\/files/, ''));
  const entry = (p) => host.entries.find((e) => e.path === p);
  check(
    'Caddy: Caddyfile, импорт по шаблону и относительный — в открытой части',
    ['/etc/caddy/Caddyfile', '/etc/caddy/sites/a.caddy', '/etc/caddy/files.caddy'].every((p) =>
      open.includes(p),
    ),
    open.join(', '),
  );
  check(
    'Caddy: имена сайтов из импортов',
    host.caddy.sites.includes('a.5espace.com') && host.caddy.sites.includes('files.5espace.com'),
  );
  check(
    'юнит: файл, drop-in, drop-in пакетного юнита — в открытой части',
    [
      '/etc/systemd/system/fifth-x.service',
      '/etc/systemd/system/fifth-x.service.d/override.conf',
      '/etc/systemd/system/caddy.service.d/limits.conf',
    ].every((p) => open.includes(p)),
  );
  check('юнит: EnvironmentFile — в зашифрованной части', secretPaths.includes('/etc/fifth-x.env'));
  check('юнит: служебная команда из ExecStart взята', open.includes('/usr/local/sbin/fifth-diag'));
  check(
    'замыкание: файл, на который ссылается команда, взят и опознан секретом по содержимому',
    secretPaths.includes('/etc/leaky.conf') && !open.includes('/etc/leaky.conf'),
  );
  check(
    'Compose: файл и примонтированная настройка — открыто, переменные .env — зашифровано',
    open.includes('/opt/fifth-element/infra/docker-compose.yml') &&
      open.includes('/opt/fifth-element/infra/nats.conf') &&
      secretPaths.includes('/opt/fifth-element/.env'),
  );
  check(
    'TLS и approle — только в зашифрованной части',
    [
      '/etc/fifth-tls/services/key.pem',
      '/etc/fifth-tls/services/ca.crt',
      '/etc/fifth-openbao/approle/prod-core/secret-id',
    ].every((p) => secretPaths.includes(p) && !open.includes(p)),
  );
  check(
    'Static seal key не взят ни в одну часть, причина записана',
    !secretPaths.some((p) => p.includes('/seal/')) &&
      !open.some((p) => p.includes('/seal/')) &&
      host.skipped.some(
        (s) => s.path.startsWith('/etc/fifth-openbao/seal') && s.kind === 'separate',
      ),
  );
  check(
    '/run не берётся: создаётся службой',
    host.skipped.some((s) => s.path === '/run/fifth-secrets' && s.kind === 'runtime'),
  );
  check('пакетный юнит без локальной правки не взят', !open.some((p) => p.includes('ssh.service')));
  check('права файла сохранены в описи', entry('/usr/local/sbin/fifth-diag')?.mode === 0o755);
  check(
    'образ контейнера записан с его ссылкой',
    host.images[0]?.containers[0]?.ref === 'nats:2.10-alpine',
  );
  check(
    'в открытой части нет значений секретов',
    !/very-secret|APPROLE-SECRET|SEAL-MUST|RealValue|PRIVATE KEY|abcdefgh1234/.test(
      r.stdout.split('\n---\n')[0].replace(/"secretPaths":\[[^\]]*\]/, ''),
    ),
  );
}
rmSync(fx, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok).length;
const outDir = join(ROOT, 'out', 'host-config');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${stamp}.json`), JSON.stringify({ at: stamp, results }, null, 2));
console.log(`=== ИТОГ: ${results.length - failed} OK, ${failed} FAIL ===`);
process.exit(failed ? 1 : 0);
