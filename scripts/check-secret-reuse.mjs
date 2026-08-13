#!/usr/bin/env node
/**
 * Гейт переиспользования секретов (Ф26).
 *
 * Инцидент: одно 24-символьное значение обслуживало шесть служб
 * (`POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `NATS_PASSWORD`,
 * `MINIO_ROOT_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `S3_SECRET_ACCESS_KEY`),
 * одно 9-символьное — три вебхука. На локальном стенде это не секреты, но
 * перенос схемы в боевой контур означал бы: компрометация одной службы отдаёт
 * все шесть, а секретом одного вебхука можно подписать запрос другого.
 *
 * Что проверяется:
 *   1. `.env` (если существует) — два секрета не делят одно значение.
 *   2. `.env.example` — плейсхолдеры секретов различимы: копирование примера
 *      «как есть» не должно снова дать общие значения.
 *   3. `infra/docker-compose.yml` — fallback-значения `${VAR:-default}`
 *      секретных переменных не совпадают между службами.
 *
 * Пункты 2–3 работают без `.env` и пригодны для CI; пункт 1 — локальный.
 * Значения секретов НЕ печатаются — только имена, длины и отпечатки sha256/8.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Переменная считается секретом по имени. */
const SECRET_NAME = /(PASSWORD|SECRET|_KEY$|_KEY_|SIGNING_KEY|^KEK_)/;

/** Имена, которые секретами не являются, хотя подходят под шаблон. */
const NOT_SECRET = new Set([
  'S3_ACCESS_KEY_ID', // идентификатор доступа — не секретная половина пары
  'ARCHIVE_S3_ACCESS_KEY_ID', // то же: имя учётки архива
  'LANGFUSE_PUBLIC_KEY', // публичный ключ по определению
  'APNS_KEY_ID', // идентификатор ключа, не сам ключ
]);

/** Значения-заглушки: пустые и «выключено» не считаются переиспользованием. */
const PLACEHOLDER = /^(|null|none|disabled|-)$/i;

const failures = [];

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function checkDuplicates(source, entries) {
  const groups = new Map();
  for (const [name, value] of entries) {
    if (!SECRET_NAME.test(name) || NOT_SECRET.has(name)) continue;
    if (PLACEHOLDER.test(value)) continue;
    const key = fingerprint(value);
    if (!groups.has(key)) groups.set(key, { len: value.length, names: [] });
    groups.get(key).names.push(name);
  }
  for (const [key, group] of groups) {
    if (group.names.length > 1) {
      failures.push(
        `${source}: одно значение (len=${group.len}, sha256/8=${key}) делят ` +
          `${group.names.length} секрета: ${group.names.join(', ')}`,
      );
    }
  }
}

function parseEnvFile(path) {
  const entries = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) entries.push([m[1], m[2].trim()]);
  }
  return entries;
}

// 1. Локальный .env — только если он есть (в CI его нет, и это нормально).
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  checkDuplicates('.env', parseEnvFile(envPath));
} else {
  console.warn('check-secret-reuse: .env отсутствует — локальная проверка пропущена (CI-режим)');
}

// 2. .env.example — обязателен.
checkDuplicates('.env.example', parseEnvFile(join(ROOT, '.env.example')));

// 3. Fallback-значения docker-compose: ${VAR:-default}.
const composePath = join(ROOT, 'infra', 'docker-compose.yml');
const composeText = readFileSync(composePath, 'utf8');
const composeEntries = [];
for (const m of composeText.matchAll(/\$\{([A-Z0-9_]+):-([^}]+)\}/g)) {
  composeEntries.push([m[1], m[2].trim()]);
}
// Одна переменная может интерполироваться в нескольких местах — это не дубль.
const composeUnique = new Map(composeEntries.map(([n, v]) => [n, v]));
checkDuplicates('infra/docker-compose.yml (fallback)', [...composeUnique.entries()]);

if (failures.length > 0) {
  console.error('check-secret-reuse: ПРОВАЛ —', failures.length, 'групп переиспользования:');
  for (const f of failures) console.error('  ✗', f);
  process.exit(1);
}
console.warn('check-secret-reuse: OK — переиспользованных значений секретов нет');
