#!/usr/bin/env node
/**
 * Инициализация стрима событий в NATS JetStream.
 *
 * Ядро только ПУБЛИКУЕТ: создание и настройка стрима — операционная задача, а
 * не право приложения. Приложение, которое само создаёт стримы, обязано иметь
 * права на управление ими, а такие права позволяют и удалить стрим вместе со
 * всей историей событий.
 *
 * Но «операционная задача» не означает «устное знание». До этого скрипта стрим
 * не существовал вовсе, и публикация молча копилась в outbox с ошибкой 503
 * («нет стрима, принимающего этот subject») — 189 событий на момент находки в
 * сквозном прогоне Ф11. Манифест стрима должен лежать в репозитории и
 * применяться командой.
 *
 * Запуск: node scripts/nats-init-stream.mjs [--recreate]
 */
import { connect } from 'nats';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

const STREAM = process.env.NATS_STREAM ?? 'LAUNCH';

/**
 * Предметы стрима.
 *
 * Перечислены доменными префиксами, а не одним `>`: стрим, принимающий всё
 * подряд, примет и чужое сообщение с опечаткой в subject — и оно осядет в
 * истории событий платформы как настоящее.
 */
const SUBJECTS = [
  'lab.>',
  'investment.>',
  'billing.>',
  'identity.>',
  'security.>',
  'integration.>',
];

const nats = await connect({
  servers: process.env.NATS_URL || 'nats://127.0.0.1:4222',
  user: process.env.NATS_USER || undefined,
  pass: process.env.NATS_PASSWORD || undefined,
  timeout: 5_000,
});

const manager = await nats.jetstreamManager();

const config = {
  name: STREAM,
  subjects: SUBJECTS,
  // Событие — свидетельство о факте, а не кеш: хранится в файлах, а не в памяти.
  storage: 'file',
  // Дедупликация на стороне стрима: повторная публикация того же msgID при
  // ретрае публикатора не создаёт второго сообщения у потребителя.
  duplicate_window: 5 * 60 * 1_000_000_000,
  // Ограничение по возрасту, а не по числу: история событий обязана пережить
  // всплеск активности, а не вытесняться им. Архив старше срока уезжает в
  // холодное хранилище отдельной процедурой (TODO).
  max_age: 90 * 24 * 60 * 60 * 1_000_000_000,
  discard: 'old',
  num_replicas: 1,
};

const recreate = process.argv.includes('--recreate');

try {
  const info = await manager.streams.info(STREAM);
  if (recreate) {
    // Пересоздание удаляет ИСТОРИЮ СОБЫТИЙ — требует явного флага и никогда не
    // выполняется по умолчанию.
    await manager.streams.delete(STREAM);
    const created = await manager.streams.add(config);
    console.warn(`Стрим ${STREAM} пересоздан. Subjects: ${created.config.subjects.join(', ')}`);
  } else {
    const updated = await manager.streams.update(STREAM, config);
    console.warn(
      `Стрим ${STREAM} уже существует, конфигурация приведена к манифесту.\n` +
        `  сообщений: ${info.state.messages}, subjects: ${updated.config.subjects.join(', ')}`,
    );
  }
} catch (error) {
  if (String(error.message).includes('stream not found')) {
    const created = await manager.streams.add(config);
    console.warn(`Стрим ${STREAM} создан. Subjects: ${created.config.subjects.join(', ')}`);
  } else {
    console.error(`Не удалось настроить стрим ${STREAM}: ${error.message}`);
    await nats.drain();
    process.exit(1);
  }
}

const final = await manager.streams.info(STREAM);
console.warn(
  `Готово: хранилище ${final.config.storage}, срок хранения ` +
    `${Math.round(Number(final.config.max_age) / 86_400_000_000_000)} дней, ` +
    `окно дедупликации ${Math.round(Number(final.config.duplicate_window) / 60_000_000_000)} мин.`,
);

await nats.drain();
