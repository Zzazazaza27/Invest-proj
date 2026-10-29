#!/usr/bin/env node
/**
 * Что сейчас развёрнуто на стенде — в файл, а не в голову.
 *
 * До этого состояние сервера узнавалось только заходом по SSH: сервер
 * недоступен — узнать нечем, а история развёртываний не сохранялась вовсе.
 * Теперь снимок кладётся в `docs/runbooks/stands-status.md`, и его видно
 * без доступа к серверу и без git.
 *
 * Скрипт ничего не меняет на сервере: только читает и записывает файл.
 *
 * Запуск:
 *   node scripts/stand-status.mjs            снять состояние и переписать файл
 *   node scripts/stand-status.mjs --dry-run  показать, ничего не записывая
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(ROOT, 'docs/runbooks/stands-status.md');
const DRY = process.argv.includes('--dry-run');

const HOST = 'root@193.233.217.210';
const KEY = resolve(homedir(), '.ssh', 'launchbridge_ed25519');
const APP_DIR = '/opt/unicorn-launch';
const PUBLIC_URL = process.env.STAND_PUBLIC_URL ?? 'https://5espace.com';

/** Команда на сервере. Пустая строка вместо падения: недоступный стенд — тоже факт. */
function onServer(cmd) {
  try {
    return execSync(
      `ssh -i "${KEY}" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20 ${HOST} "${cmd}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
}

const local = (cmd) => execSync(cmd, { encoding: 'utf8', cwd: ROOT }).trim();

console.warn('Снимаю состояние стенда…');

const serverSha = onServer(`cd ${APP_DIR} && git rev-parse --short HEAD`);
const online = serverSha !== '';

const serverSubject = online ? onServer(`cd ${APP_DIR} && git log -1 --pretty=%s`) : '';
const serverDate = online ? onServer(`cd ${APP_DIR} && git log -1 --date=short --pretty=%ad`) : '';
const serverDirty = online ? onServer(`cd ${APP_DIR} && git status --porcelain | head -20`) : '';
const services = online
  ? onServer("systemctl is-active unicorn-core caddy 2>/dev/null | paste -sd' '")
  : '';
const containers = online ? onServer("docker ps --format '{{.Names}} {{.Status}}' | head -8") : '';
const health = online ? onServer(`curl -s -m 10 ${PUBLIC_URL}/v1/health`) : '';
const uptime = online ? onServer('uptime -p 2>/dev/null || uptime') : '';

/**
 * Тег, которым помечено развёрнутое состояние. Коммит сам по себе ничего не
 * говорит человеку — тег говорит: вот это стоит на стенде и вот почему.
 */
const serverTag = online
  ? (() => {
      try {
        return local(`git tag --points-at ${serverSha}`).split('\n')[0] || '';
      } catch {
        return '';
      }
    })()
  : '';

const localSha = local('git rev-parse --short HEAD');
const localSubject = local('git log -1 --pretty=%s');
const behind =
  online && serverSha
    ? (() => {
        try {
          return local(`git rev-list --count ${serverSha}..HEAD`);
        } catch {
          return '?';
        }
      })()
    : '?';

const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

const dirtyBlock = serverDirty
  ? `\n> **На сервере есть незакоммиченные изменения** — кто-то правил файлы руками,\n> мимо git. Разберитесь, что это:\n>\n> \`\`\`\n> ${serverDirty.split('\n').join('\n> ')}\n> \`\`\`\n`
  : '';

const body = `# Состояние стендов

<!--
  Файл собирается скриптом: node scripts/stand-status.mjs
  Руками не правьте — перезапишется. Нужна заметка, которая переживёт
  пересборку, — пишите её в раздел «Заметки» в конце.
-->

Снято: **${now}** (${DRY ? 'пробный прогон' : 'автоматически'})

## Боевой стенд

| Что | Значение |
| --- | --- |
| Адрес | ${PUBLIC_URL}/ (по IP не открывается — сертификат только на домен) |
| Хост | 193.233.217.210, \`unicorn.ptr.network\` |
| Доступность | ${online ? 'отвечает' : '**НЕ ОТВЕЧАЕТ** — SSH не прошёл'} |
| Развёрнутый коммит | ${online ? `\`${serverSha}\` от ${serverDate}` : '—'} |
| Тег | ${serverTag ? `\`${serverTag}\`` : 'не помечен — поставьте тег, иначе состояние потом не опознать'} |
| Что это за коммит | ${online ? serverSubject || '—' : '—'} |
| Отставание от \`main\` | ${online ? (behind === '0' ? 'нет, совпадает' : `**${behind} коммит(ов)**`) : '—'} |
| Аптайм | ${uptime || '—'} |
| Службы | ${services || '—'} |
| Health | ${health || '—'} |
${dirtyBlock}
### Контейнеры

\`\`\`
${containers || '(нет данных)'}
\`\`\`

## Локальная копия

| Что | Значение |
| --- | --- |
| Коммит | \`${localSha}\` |
| Что это за коммит | ${localSubject} |
| Адрес | http://127.0.0.1/ |

## Как обновить этот файл

\`\`\`bash
node scripts/stand-status.mjs
\`\`\`

Скрипт только читает сервер и переписывает эту страницу; на стенде он ничего
не меняет.

## Заметки

Сюда — то, что скрипт не соберёт: почему стенд отстаёт, что решили не
разворачивать, когда планируется обновление. Этот раздел при пересборке
сохраняется.
`;

if (DRY) {
  console.warn('\n--- пробный прогон, файл не записан ---\n');
  console.warn(body);
  process.exit(0);
}

// Раздел «Заметки» пишет человек — при пересборке его надо сохранить.
let keep = '';
try {
  const prev = readFileSync(OUT, 'utf8');
  const i = prev.indexOf('## Заметки');
  if (i !== -1) {
    const tail = prev
      .slice(i + '## Заметки'.length)
      .replace(/^\s*Сюда — то, что скрипт не соберёт:[\s\S]*?сохраняется\.\s*/, '')
      .trim();
    if (tail) keep = `\n${tail}\n`;
  }
} catch {
  // файла ещё нет — нечего сохранять
}

writeFileSync(OUT, body + keep, 'utf8');
console.warn(`Записано: ${OUT}`);
console.warn(
  online
    ? `Стенд на ${serverSha}, локально ${localSha}${behind !== '0' ? ` — отставание ${behind}` : ' — совпадает'}`
    : 'Стенд не ответил: записано как недоступный',
);
