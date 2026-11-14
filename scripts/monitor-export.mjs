#!/usr/bin/env node
/**
 * Состояние контейнеров для агента Zabbix (блок 8, 8.2; 2.1-W08a).
 *
 * Агент не получает Docker socket: он даёт управление контейнерами, а не
 * чтение (8.2). Вместо этого таймер узла раз в минуту пишет сюда короткий
 * файл — имя, состояние, число перезапусков, должен ли контейнер работать
 * (политика перезапуска не `no`), остановлено ли автовосстановление зависшего ядра
 * (`recoveryStopped` — по строке состояния проверки здоровья, core-health.mjs). Агент читает
 * файл только на чтение.
 *
 * Отбор — по префиксу `fifth-`: прежний `unicorn-` после переименования не находил ни одного
 * контейнера, и выгрузка была пустой (найдено 09.11.2026).
 *
 *   node scripts/monitor-export.mjs        записать MONITOR_STATE_DIR/containers.json
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, loadEnv } from './lib/backup.mjs';
import { containerRecord, standbyContainers } from './lib/monitor-containers.mjs';

loadEnv();
const dir = resolve(process.env.MONITOR_STATE_DIR || join(ROOT, '.local', 'monitor-state'));
mkdirSync(dir, { recursive: true });

// Резервные слоты ядра (рабочая среда и тестовые) — по их файлам маршрута.
const readRoute = (f) => {
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
  } catch {
    return null;
  }
};
const envsDir = join(ROOT, '.local', 'envs');
const standby = standbyContainers([
  { prefix: 'fifth', route: readRoute(join(ROOT, '.local', 'release', 'core-route.json')) },
  ...(existsSync(envsDir) ? readdirSync(envsDir) : [])
    .filter((id) => /^test-[0-9]+$/.test(id))
    .map((id) => ({
      prefix: `fifth-${id}`,
      route: readRoute(join(envsDir, id, 'release', 'core-route.json')),
    })),
]);

const ids = execFileSync('docker', ['ps', '-aq', '--filter', 'name=fifth-'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const containers = ids.length
  ? JSON.parse(execFileSync('docker', ['inspect', ...ids], { encoding: 'utf8' })).map((c) =>
      containerRecord(c, standby),
    )
  : [];

const target = join(dir, 'containers.json');
writeFileSync(
  `${target}.tmp`,
  JSON.stringify({ at: new Date().toISOString(), containers }, null, 2),
);
renameSync(`${target}.tmp`, target);
console.log(
  `контейнеров: ${containers.length}, не работают: ${containers.filter((c) => c.expected && c.state !== 'running').length}, автовосстановление остановлено: ${containers.filter((c) => c.recoveryStopped).length}, петля падений: ${containers.filter((c) => c.crashLoop).length}`,
);

// Состояние выпуска рабочей среды (блок 09, задание 4): release.json для агента Zabbix. Сбой
// команды файл не обновляет — тревога «состояние выпуска не обновляется», то есть неизвестно.
const release = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'release.mjs'), 'watch', 'prod', '--out', join(dir, 'release.json')],
  { encoding: 'utf8', timeout: 60_000 },
);
const verdict = /"verdict":"(\w+)"/.exec(release.stdout ?? '')?.[1] ?? 'не получено';
console.log(`выпуск: ${verdict}`);
