#!/usr/bin/env node
/**
 * Очистка потока событий JetStream стенда (обнуление данных, 29.10.2026).
 *
 * Поток — копия событий outbox для потребителей; после очистки БД в нём
 * остаются события о людях и проектах, которых больше нет. Сам поток и его
 * настройки сохраняются — удаляются только сообщения.
 *
 * Запуск из корня репозитория стенда:
 *   node scripts/purge-event-stream.mjs          показать число сообщений
 *   node scripts/purge-event-stream.mjs --yes    очистить
 */
import { connect } from 'nats';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const envFile = join(process.cwd(), '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const stream = process.env.NATS_STREAM || 'LAUNCH';
const nc = await connect({
  servers: process.env.NATS_URL,
  user: process.env.NATS_USER || undefined,
  pass: process.env.NATS_PASSWORD || undefined,
  timeout: 10_000,
});
try {
  const jsm = await nc.jetstreamManager();
  const before = await jsm.streams.info(stream);
  console.warn(`Поток ${stream}: сообщений ${before.state.messages}, байт ${before.state.bytes}`);
  if (process.argv.includes('--yes')) {
    await jsm.streams.purge(stream);
    const after = await jsm.streams.info(stream);
    console.warn(`После очистки: сообщений ${after.state.messages}`);
  } else {
    console.warn('Пробный режим. Для очистки: --yes');
  }
} finally {
  await nc.close();
}
