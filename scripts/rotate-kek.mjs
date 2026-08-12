#!/usr/bin/env node
// Ротация ключа домена (KEK) без перешифровки данных.
//
// Схема шифрования — конвертная (apps/core/src/crypto/crypto.service.ts):
// значение шифруется одноразовым DEK, а KEK шифрует только сам DEK. Поэтому
// смена KEK означает ПЕРЕОБЁРТКУ DEK, а не перешифровку данных: шифртексты
// (email_ciphertext, document_ciphertext и прочие) не меняются вовсе.
//
// Отсюда ответ на вопрос «не обнулит ли замена ключа данные»: обнулит только
// слепая подстановка нового значения в .env без переобёртки — тогда старые
// wrapped_dek перестанут открываться. Правильная ротация данные не трогает.
//
// Не все домены одинаковы:
//   • конвертные (passport_sensitive, kyb_documents, investment_documents)
//     — переобёртка, дёшево, данные не читаются;
//   • прямые (webhook_secrets) — sealDirect шифрует секрет самим KEK,
//     нужна ПЕРЕШИФРОВКА строк;
//   • индексный (search_index) — KEK используется как ключ HMAC для blind
//     index; смена инвалидирует ВСЕ индексы, их придётся пересчитать из
//     открытых значений. Это отдельная процедура, здесь не выполняется.
//
// Режимы:
//   (по умолчанию)  только осмотр: сколько строк затронуто, открывается ли
//                   текущий KEK — ничего не пишется;
//   --test          выполняет ротацию в транзакции и откатывает её. Полная
//                   проверка механики без последствий;
//   --apply         выполняет и фиксирует.
//
// Новый ключ: --new-key <base64 32 байта> либо --generate.
// Значение нового ключа печатается ТОЛЬКО при --generate и только один раз —
// его нужно немедленно положить в .env и пересобрать локальный пак редакции
// (npm run secrets:redactors).
//
// Примеры:
//   node scripts/rotate-kek.mjs --domain passport_sensitive
//   node scripts/rotate-kek.mjs --domain passport_sensitive --generate --test
//   node scripts/rotate-kek.mjs --domain passport_sensitive --new-key <base64> --apply

import { readFileSync, existsSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

// Соответствие домена и мест хранения обёрнутых DEK. Источник истины —
// вызовы crypto.seal/sealMany в apps/core/src.
const ENVELOPE = {
  passport_sensitive: [
    {
      table: 'identity.users',
      dek: 'contact_wrapped_dek',
      probe: { column: 'email_ciphertext', aad: 'field:email' },
    },
  ],
  kyb_documents: [
    {
      table: 'kyc.business_entities',
      dek: 'entity_wrapped_dek',
      probe: { column: 'inn_ciphertext', aad: 'field:inn' },
    },
  ],
  investment_documents: [
    { table: 'investments.investment_offers', dek: 'document_wrapped_dek', probe: null },
    { table: 'investments.investment_agreements', dek: 'document_wrapped_dek', probe: null },
  ],
};

// Домены, которые этим скриптом не ротируются, и почему.
const NOT_ENVELOPE = {
  webhook_secrets:
    'секрет шифруется KEK напрямую (sealDirect) — нужна перешифровка ' +
    'integration.webhook_endpoints.secret_ciphertext, а не переобёртка',
  search_index:
    'KEK служит ключом HMAC для blind index — смена инвалидирует все ' +
    'email_hmac/phone_hmac/inn_hmac, их нужно пересчитать из открытых значений',
};

const ENV_BY_DOMAIN = {
  kyc_documents: 'KEK_KYC_DOCUMENTS',
  kyb_documents: 'KEK_KYB_DOCUMENTS',
  passport_sensitive: 'KEK_PASSPORT_SENSITIVE',
  investment_documents: 'KEK_INVESTMENT_DOCUMENTS',
  nominal_account_evidence: 'KEK_NOMINAL_ACCOUNT_EVIDENCE',
  billing_documents: 'KEK_BILLING_DOCUMENTS',
  search_index: 'KEK_SEARCH_INDEX',
  webhook_secrets: 'KEK_WEBHOOK_SECRETS',
};

function encrypt(key, plaintext, aad) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(key, payload, aad) {
  if (payload.length < IV_BYTES + TAG_BYTES)
    throw new Error('повреждённые данные: недостаточная длина');
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = payload.subarray(IV_BYTES + TAG_BYTES);
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  d.setAuthTag(tag);
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([d.update(body), d.final()]);
}

const digest = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);

function readEnvValue(name) {
  if (process.env[name]) return process.env[name];
  const path = resolve(ROOT, '.env');
  if (!existsSync(path)) return null;
  const m = readFileSync(path, 'utf8').match(new RegExp(`^${name}=(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

// --- разбор аргументов -------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};

const domain = value('--domain');
const mode = flag('--apply') ? 'apply' : flag('--test') ? 'test' : 'check';

if (!domain) {
  console.error('нужен --domain. Конвертные домены: ' + Object.keys(ENVELOPE).join(', '));
  console.error('Не ротируются этим скриптом: ' + Object.keys(NOT_ENVELOPE).join(', '));
  process.exit(1);
}

if (NOT_ENVELOPE[domain]) {
  console.error(`домен ${domain} этим скриптом не ротируется:`);
  console.error(`  ${NOT_ENVELOPE[domain]}`);
  process.exit(1);
}

if (!ENVELOPE[domain]) {
  const known = Object.keys(ENV_BY_DOMAIN).includes(domain);
  console.error(
    known
      ? `домен ${domain} объявлен, но им ничего не зашифровано — ротация сводится к замене значения в .env`
      : `неизвестный домен ${domain}`,
  );
  process.exit(1);
}

const oldRaw = readEnvValue(ENV_BY_DOMAIN[domain]);
const oldKek = Buffer.from(oldRaw ?? '', 'base64');
if (oldKek.length !== DEK_BYTES) {
  console.error(`${ENV_BY_DOMAIN[domain]} не задан или неверной длины (нужно 32 байта в base64)`);
  process.exit(1);
}

let newKek = null;
let generated = false;
if (flag('--generate')) {
  newKek = randomBytes(DEK_BYTES);
  generated = true;
} else if (value('--new-key')) {
  newKek = Buffer.from(value('--new-key'), 'base64');
  if (newKek.length !== DEK_BYTES) {
    console.error('--new-key должен быть 32 байтами в base64');
    process.exit(1);
  }
}

if (mode !== 'check' && !newKek) {
  console.error('для --test и --apply нужен новый ключ: --generate или --new-key <base64>');
  process.exit(1);
}

if (newKek && oldKek.equals(newKek)) {
  console.error('новый ключ совпадает со старым — ротация бессмысленна');
  process.exit(1);
}

const url = readEnvValue('DATABASE_URL_OWNER') ?? readEnvValue('DATABASE_URL');
if (!url) {
  console.error('не найден DATABASE_URL_OWNER или DATABASE_URL');
  process.exit(1);
}

// --- работа ------------------------------------------------------------------
const client = new pg.Client({ connectionString: url });
await client.connect();

console.warn(`домен: ${domain} (${ENV_BY_DOMAIN[domain]})`);
console.warn(
  `режим: ${mode === 'check' ? 'осмотр, без записи' : mode === 'test' ? 'ротация с откатом' : 'РОТАЦИЯ С ФИКСАЦИЕЙ'}`,
);
console.warn('');

let totalRows = 0;
let totalRewrapped = 0;
let failures = 0;

try {
  if (mode !== 'check') await client.query('BEGIN');

  for (const target of ENVELOPE[domain]) {
    const cols = ['id', target.dek];
    if (target.probe) cols.push(target.probe.column);
    const { rows } = await client.query(
      `SELECT ${cols.join(', ')} FROM ${target.table} WHERE ${target.dek} IS NOT NULL`,
    );
    totalRows += rows.length;

    let rewrapped = 0;
    let probesOk = 0;
    for (const row of rows) {
      const wrapped = row[target.dek];
      let dek;
      try {
        dek = decrypt(oldKek, wrapped, `wrap:${domain}`);
      } catch {
        failures++;
        continue;
      }

      // Доказательство сохранности: DEK после переобёртки обязан совпасть
      // побайтово. Если совпал — все шифртексты, зашифрованные им, открываются
      // по-прежнему, потому что сами шифртексты не менялись.
      const before = digest(dek);

      if (target.probe && row[target.probe.column]) {
        try {
          decrypt(dek, row[target.probe.column], target.probe.aad);
          probesOk++;
        } catch {
          failures++;
        }
      }

      if (newKek) {
        const rewrappedDek = encrypt(newKek, dek, `wrap:${domain}`);
        const check = decrypt(newKek, rewrappedDek, `wrap:${domain}`);
        if (digest(check) !== before) {
          failures++;
          dek.fill(0);
          continue;
        }
        if (mode !== 'check') {
          await client.query(`UPDATE ${target.table} SET ${target.dek} = $1 WHERE id = $2`, [
            rewrappedDek,
            row.id,
          ]);
        }
        rewrapped++;
      }
      dek.fill(0);
    }

    totalRewrapped += rewrapped;
    const probeNote = target.probe ? `, проверено открытием поля: ${probesOk}` : '';
    console.warn(
      `${target.table}.${target.dek}: строк ${rows.length}${probeNote}${newKek ? `, переобёрнуто ${rewrapped}` : ''}`,
    );
  }

  if (failures > 0) {
    console.error('');
    console.error(`ОШИБОК: ${failures} — ротация не выполнена`);
    if (mode !== 'check') await client.query('ROLLBACK');
    await client.end();
    process.exit(1);
  }

  if (mode === 'test') {
    // Контроль: перед откатом убеждаемся, что записанное открывается НОВЫМ
    // ключом и не открывается старым.
    const t = ENVELOPE[domain][0];
    const { rows } = await client.query(
      `SELECT ${t.dek} FROM ${t.table} WHERE ${t.dek} IS NOT NULL LIMIT 1`,
    );
    if (rows.length) {
      let newOk = false;
      let oldRejected = false;
      try {
        decrypt(newKek, rows[0][t.dek], `wrap:${domain}`);
        newOk = true;
      } catch {
        /* остаётся false */
      }
      try {
        decrypt(oldKek, rows[0][t.dek], `wrap:${domain}`);
      } catch {
        oldRejected = true;
      }
      console.warn('');
      console.warn(
        `контроль записанного: новым ключом открывается — ${newOk ? 'да' : 'НЕТ'}; старым отвергается — ${oldRejected ? 'да' : 'НЕТ'}`,
      );
      if (!newOk || !oldRejected) {
        await client.query('ROLLBACK');
        await client.end();
        console.error('контроль не пройден — откат');
        process.exit(1);
      }
    }
    await client.query('ROLLBACK');
    console.warn('транзакция откачена: база не изменена');
  } else if (mode === 'apply') {
    await client.query('COMMIT');
    console.warn('');
    console.warn(`зафиксировано: переобёрнуто ${totalRewrapped} из ${totalRows} строк`);
    console.warn('');
    console.warn('ДАЛЬШЕ, не откладывая:');
    console.warn(`  1) заменить ${ENV_BY_DOMAIN[domain]} в .env на новое значение;`);
    console.warn('  2) npm run secrets:redactors — иначе новый ключ уйдёт в транскрипт открытым;');
    console.warn('  3) перезапустить ядро.');
    console.warn('До шага 1 приложение работает со СТАРЫМ ключом и данные не откроются.');
    if (generated) {
      console.warn('');
      console.warn(`новое значение ${ENV_BY_DOMAIN[domain]} (показывается один раз):`);
      console.warn(newKek.toString('base64'));
    }
  } else {
    console.warn('');
    console.warn(`итого строк: ${totalRows}, текущий ключ открывает все обёртки`);
    console.warn('данные при ротации НЕ перешифровываются — меняется только обёртка DEK');
  }
} catch (e) {
  if (mode !== 'check') {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* соединение уже могло закрыться */
    }
  }
  console.error(`сбой: ${e.message}`);
  await client.end();
  process.exit(1);
}

await client.end();
