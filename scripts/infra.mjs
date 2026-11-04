#!/usr/bin/env node
/**
 * Обёртка над `docker compose` для инфраструктуры стенда.
 *
 * Существует ради одной ловушки: compose читает файл `.env` РЯДОМ С СОБОЙ
 * (то есть `infra/.env`), а не корневой `.env` проекта. Команда
 * `docker compose -f infra/docker-compose.yml up -d` поэтому поднимала
 * контейнеры на fallback-значениях `${VAR:-default}` — с дефолтными паролями
 * Redis и MinIO и на дефолтных портах, — и выглядело это полностью исправным:
 * контейнеры healthy, а приложение, читающее корневой `.env`, стучится с
 * другим паролем на другой порт.
 *
 * Здесь корневой `.env` передаётся явно через `--env-file`. Если файла нет
 * (свежий клон), запуск идёт без него — на дефолтах compose, и об этом
 * сообщается вслух, а не молчанием.
 *
 * Запуск: node scripts/infra.mjs up | down | reset [доп. аргументы compose]
 *         node scripts/infra.mjs compose <любая команда compose>
 * DOCKER_LOG_DRIVER=journald (.env VPS) подключает infra/docker-compose.journald.yml.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(ROOT, '.env');
const COMPOSE_PATH = join(ROOT, 'infra', 'docker-compose.yml');
const JOURNALD_PATH = join(ROOT, 'infra', 'docker-compose.journald.yml');
const PROD_PATH = join(ROOT, 'infra', 'docker-compose.prod.yml');

/**
 * Боевое ли это окружение.
 *
 * Локальные дополнения (публикация служебной консоли на едином адресе)
 * подключаются ТОЛЬКО когда ответ «нет». Проверка положительная, а не
 * отрицательная: неизвестное значение считается боевым — забытая переменная
 * не должна открывать наружу то, что открывать не собирались.
 */

const COMMANDS = {
  up: ['up', '-d'],
  down: ['down'],
  // Остановка без удаления: контейнеры остаются, тома с данными тоже, и
  // следующий запуск занимает секунды. `down` пересоздаёт контейнеры, а
  // `reset` вдобавок удаляет тома — три разных действия с тремя именами,
  // чтобы «остановить стенд» никогда не означало «стереть базу».
  stop: ['--profile', 'web', 'stop'],
  reset: ['down', '-v'],
  // Прокси живёт в отдельном профиле: инфраструктуре он не нужен, а поднимать
  // его при каждом `infra:up` означало бы держать порт 80 занятым без причины.
  'web-up': ['--profile', 'web', 'up', '-d', 'web'],
  'web-down': ['--profile', 'web', 'stop', 'web'],
  // Почтовый приёмник — тоже отдельным профилем и по той же причине: он нужен
  // прогону SMTP-транспорта, а не каждому запуску инфраструктуры. Держать
  // открытым лишний слушатель без надобности — это расширять периметр даром.
  'mail-up': ['--profile', 'full', 'up', '-d', 'mailpit'],
  'mail-down': ['--profile', 'full', 'stop', 'mailpit'],
  // Любая команда compose с теми же файлами, что у остальных команд (в том
  // числе дополнение journald) — для ручных шагов на VPS.
  compose: [],
};

const [command, ...rest] = process.argv.slice(2);
const tail = COMMANDS[command];

if (!tail) {
  console.error(`Использование: node scripts/infra.mjs <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}

const args = ['compose'];

if (existsSync(ENV_PATH)) {
  args.push('--env-file', ENV_PATH);
} else {
  console.warn(
    'infra: корневой .env не найден — compose поднимется на дефолтных значениях\n' +
      '       (пароли из fallback, порты по умолчанию). Скопируй .env.example в .env.',
  );
}

args.push('-f', COMPOSE_PATH);

// Журналы контейнеров в journald (2.1-W08b): дополнение подключается только
// при DOCKER_LOG_DRIVER=journald (окружение или .env). Без него основной файл
// не меняется и выкладка ничего не пересоздаёт; с ним — драйвер у всех
// команд стенда одинаковый, ручной `docker compose -f …` его бы потерял.
const logDriver =
  process.env.DOCKER_LOG_DRIVER ??
  (existsSync(ENV_PATH)
    ? readFileSync(ENV_PATH, 'utf8')
        .match(/^DOCKER_LOG_DRIVER=(.*)$/m)?.[1]
        ?.trim()
    : undefined);
// Рабочая среда из комплекта: образы заданы в .env (W09d).
if (existsSync(ENV_PATH) && /^FIFTH_CORE_IMAGE=./m.test(readFileSync(ENV_PATH, 'utf8'))) {
  args.push('-f', PROD_PATH);
}
if (logDriver === 'journald') args.push('-f', JOURNALD_PATH);
else if (logDriver) {
  console.error(`infra: DOCKER_LOG_DRIVER=${logDriver} — допустимо только journald или пусто`);
  process.exit(2);
}

args.push(...tail, ...rest);

// `reset` удаляет тома вместе с данными БД и объектами хранилища. Это
// необратимо, поэтому здесь оно хотя бы названо вслух до запуска, а не
// обнаруживается по пустой базе.
if (command === 'reset') {
  console.warn('infra: reset удаляет тома — данные БД, Valkey и MinIO будут потеряны.');
}

console.warn(
  `infra: ${command} — postgres:${PORTS.postgres} valkey:${PORTS.redis} ` +
    `nats:${PORTS.nats} s3:${PORTS.s3}`,
);
// На Linux nginx не может найти host.docker.internal через DNS Docker (см.
// infra/nginx/default.conf), поэтому хост ядра передаётся адресом: шлюз сети
// bridge — тот же адрес, который extra_hosts кладёт по host-gateway.
const env = { ...process.env };
if (process.platform === 'linux' && !env.CORE_HOST) {
  const gw = spawnSync(
    'docker',
    ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'],
    { encoding: 'utf8' },
  );
  const ip = gw.status === 0 ? gw.stdout.trim() : '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) env.CORE_HOST = ip;
  else console.warn('infra: не удалось узнать шлюз Docker — /v1/ через прокси может не работать');
}

const result = spawnSync('docker', args, { stdio: 'inherit', cwd: ROOT, env });

if (result.error) {
  console.error(`infra: не удалось запустить docker — ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
