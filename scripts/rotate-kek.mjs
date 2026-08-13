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
// Не все домены одинаковы — у каждого класса свой режим (Ф30):
//   • конвертные (passport_sensitive, kyb_documents, investment_documents)
//     — переобёртка DEK, дёшево, данные не читаются;
//   • прямой (webhook_secrets) — sealDirect шифрует секрет самим KEK:
//     ПЕРЕШИФРОВКА каждого secret_ciphertext с контролем на строке;
//   • индексный (search_index) — KEK служит ключом HMAC blind index:
//     ПЕРЕСЧЁТ email_hmac/phone_hmac/inn_hmac из расшифрованных значений;
//     контроль на строке — старый HMAC обязан воспроизвестись. НЕ пересчитываются
//     consents.request_trace_hash/user_agent_hash: исходники не хранятся.
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

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

// Соответствие домена и мест хранения обёрнутых DEK. Источник истины —
// вызовы crypto.seal/sealMany в apps/core/src. Карта сверяется гейтом
// `npm run gate:kek` (scripts/check-kek-domains.mjs): новая колонка
// *_wrapped_dek или новый вызов seal* без записи здесь роняют гейт.
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

// Домены, которые ротируются НЕ переобёрткой DEK, а собственными режимами
// этого же скрипта (Ф30). Ключи карты сверяет гейт `npm run gate:kek`.
const NOT_ENVELOPE = {
  webhook_secrets:
    'секрет шифруется KEK напрямую (sealDirect) — ротация перешифровывает ' +
    'integration.webhook_endpoints.secret_ciphertext (режим direct этого скрипта)',
  search_index:
    'KEK служит ключом HMAC blind index — ротация пересчитывает ' +
    'email_hmac/phone_hmac/inn_hmac из расшифрованных значений (режим hmac этого скрипта)',
};

// AAD прямого шифрования секрета вебхука — как в apps/core/src/events
// (WEBHOOK_SECRET_AAD). Разъезд поймает контроль расшифровки старым ключом.
const WEBHOOK_SECRET_AAD = 'webhook:signing';

/**
 * Нормализация значения перед HMAC — копия crypto.service.ts::normalize.
 * Разъезд с оригиналом ловится контролем «старый HMAC от расшифрованного
 * значения равен хранимому»: при несовпадении ротация останавливается.
 */
function normalizeForIndex(value, kind) {
  const trimmed = value.trim();
  if (kind === 'email') return trimmed.toLowerCase();
  if (kind === 'phone') return trimmed.replace(/[^\d+]/g, '');
  return trimmed.replace(/\D/g, '');
}

function blindIndex(kek, value, kind) {
  return createHmac('sha256', kek)
    .update(`${kind}:${normalizeForIndex(value, kind)}`, 'utf8')
    .digest();
}

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

// Записывает новое значение прямо в .env. Нужен, чтобы ключ не появлялся ни в
// argv (виден в списке процессов), ни в stdout (попадает в транскрипт сессии —
// ровно тот путь, которым ключи и утекли в git 2026-08-12).
function writeEnvValue(name, value) {
  const path = resolve(ROOT, '.env');
  const text = readFileSync(path, 'utf8');
  const line = new RegExp(`^${name}=.*$`, 'm');
  if (!line.test(text)) throw new Error(`в .env нет строки ${name}=`);
  const updated = text.replace(line, `${name}=${value}`);
  writeFileSync(path, updated, 'utf8');
  return text; // прежнее содержимое — для отката
}

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
// --write-env: скрипт сам подставляет новый ключ в .env. Без него значение
// пришлось бы передать через argv или прочитать с экрана — и оно осело бы в
// транскрипте сессии.
const WRITE_ENV = flag('--write-env');

if (!domain) {
  console.error('нужен --domain. Конвертные домены: ' + Object.keys(ENVELOPE).join(', '));
  console.error('Не ротируются этим скриптом: ' + Object.keys(NOT_ENVELOPE).join(', '));
  process.exit(1);
}

// Домены с собственными режимами ротации (Ф30): не переобёртка DEK.
const DIRECT_DOMAIN = domain === 'webhook_secrets';
const HMAC_DOMAIN = domain === 'search_index';

if (NOT_ENVELOPE[domain] && !DIRECT_DOMAIN && !HMAC_DOMAIN) {
  console.error(`домен ${domain} этим скриптом не ротируется:`);
  console.error(`  ${NOT_ENVELOPE[domain]}`);
  process.exit(1);
}

if (!ENVELOPE[domain] && !DIRECT_DOMAIN && !HMAC_DOMAIN) {
  const known = Object.keys(ENV_BY_DOMAIN).includes(domain);
  if (!known) {
    console.error(`неизвестный домен ${domain}`);
    process.exit(1);
  }
  // Домен объявлен, но им ничего не зашифровано: в базе нет ни одной обёртки,
  // поэтому ротация — это просто новое значение в .env, без работы с данными.
  if (mode === 'apply' && WRITE_ENV) {
    writeEnvValue(ENV_BY_DOMAIN[domain], randomBytes(DEK_BYTES).toString('base64'));
    console.warn(`${ENV_BY_DOMAIN[domain]}: новое значение записано в .env`);
    console.warn('данными домен не пользуется — переобёртка не требовалась');
    console.warn('дальше: npm run secrets:redactors');
    process.exit(0);
  }
  console.error(
    `домен ${domain} объявлен, но им ничего не зашифровано — ротация сводится к замене значения в .env`,
  );
  console.error('выполнить: npm run rotate:kek -- --domain ' + domain + ' --apply --write-env');
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

/**
 * Общий хвост apply-режима: .env пишется ДО фиксации; срыв фиксации
 * откатывает и файл, и транзакцию (тот же порядок, что у конвертной ветки).
 */
async function commitWithEnv(summaryLine) {
  if (WRITE_ENV) {
    let previousEnv;
    try {
      previousEnv = writeEnvValue(ENV_BY_DOMAIN[domain], newKek.toString('base64'));
    } catch (e) {
      await client.query('ROLLBACK');
      await client.end();
      console.error(`не удалось записать .env: ${e.message} — транзакция откачена`);
      process.exit(1);
    }
    try {
      await client.query('COMMIT');
    } catch (e) {
      writeFileSync(resolve(ROOT, '.env'), previousEnv, 'utf8');
      await client.end();
      console.error(`фиксация не прошла: ${e.message} — .env возвращён к прежнему значению`);
      process.exit(1);
    }
    console.warn('');
    console.warn(`зафиксировано: ${summaryLine}`);
    console.warn(`${ENV_BY_DOMAIN[domain]}: новое значение записано в .env`);
    console.warn('значение нигде не печаталось — в транскрипт сессии оно не попало');
    console.warn('');
    console.warn('ДАЛЬШЕ: npm run secrets:redactors, затем перезапустить ядро.');
  } else {
    await client.query('COMMIT');
    console.warn('');
    console.warn(`зафиксировано: ${summaryLine}`);
    console.warn(
      'ДАЛЬШЕ: заменить значение в .env, npm run secrets:redactors, перезапустить ядро.',
    );
    if (generated) {
      console.warn(`новое значение ${ENV_BY_DOMAIN[domain]} (показывается один раз):`);
      console.warn(newKek.toString('base64'));
    }
  }
}

/**
 * Режим direct (webhook_secrets): секрет зашифрован KEK напрямую, ротация —
 * перешифровка каждого secret_ciphertext. Контроль на каждой строке:
 * расшифровка старым → шифрование новым → обратная расшифровка совпадает.
 */
async function rotateWebhookSecrets() {
  const table = 'integration.webhook_endpoints';
  const lock = mode === 'check' ? '' : ' FOR UPDATE';
  const { rows } = await client.query(
    `SELECT id, secret_ciphertext FROM ${table} WHERE secret_ciphertext IS NOT NULL${lock}`,
  );
  let reencrypted = 0;
  let bad = 0;
  for (const row of rows) {
    let plain;
    try {
      plain = decrypt(oldKek, row.secret_ciphertext, WEBHOOK_SECRET_AAD);
    } catch {
      bad++;
      continue;
    }
    if (newKek) {
      const fresh = encrypt(newKek, plain, WEBHOOK_SECRET_AAD);
      const back = decrypt(newKek, fresh, WEBHOOK_SECRET_AAD);
      if (digest(back) !== digest(plain)) {
        bad++;
        plain.fill(0);
        continue;
      }
      if (mode !== 'check') {
        await client.query(`UPDATE ${table} SET secret_ciphertext = $1 WHERE id = $2`, [
          fresh,
          row.id,
        ]);
      }
      reencrypted++;
    }
    plain.fill(0);
  }
  console.warn(
    `${table}.secret_ciphertext: строк ${rows.length}, старым ключом открыто ${rows.length - bad}` +
      (newKek ? `, перешифровано ${reencrypted}` : ''),
  );
  if (bad > 0) {
    if (mode !== 'check') await client.query('ROLLBACK');
    console.error(`ОШИБОК: ${bad} — ротация не выполнена`);
    process.exit(1);
  }
  if (mode === 'test') {
    const { rows: after } = await client.query(
      `SELECT secret_ciphertext FROM ${table} WHERE secret_ciphertext IS NOT NULL LIMIT 1`,
    );
    let newOk = false;
    let oldRejected = false;
    if (after.length) {
      try {
        decrypt(newKek, after[0].secret_ciphertext, WEBHOOK_SECRET_AAD);
        newOk = true;
      } catch {
        /* остаётся false */
      }
      try {
        decrypt(oldKek, after[0].secret_ciphertext, WEBHOOK_SECRET_AAD);
      } catch {
        oldRejected = true;
      }
      console.warn(
        `контроль записанного: новым ключом открывается — ${newOk ? 'да' : 'НЕТ'}; старым отвергается — ${oldRejected ? 'да' : 'НЕТ'}`,
      );
      if (!newOk || !oldRejected) {
        await client.query('ROLLBACK');
        console.error('контроль не пройден — откат');
        process.exit(1);
      }
    }
    await client.query('ROLLBACK');
    console.warn('транзакция откачена: база не изменена');
  } else if (mode === 'apply') {
    await commitWithEnv(`перешифровано ${reencrypted} из ${rows.length} секретов вебхуков`);
  } else {
    console.warn(`итого строк: ${rows.length}, текущий ключ открывает все секреты`);
  }
}

/**
 * Режим hmac (search_index): blind index пересчитывается из расшифрованных
 * значений. Контроль на каждой строке ДО записи: HMAC СТАРЫМ ключом от
 * расшифрованного значения обязан совпасть с хранимым — это доказывает, что
 * расшифровка и нормализация воспроизводят оригинальный конвейер.
 *
 * НЕ пересчитываются consents.request_trace_hash и user_agent_hash: их
 * исходные значения не хранятся. Историческая связка с журналом остаётся
 * проверяемой только прежним ключом — свойство названо, а не скрыто.
 */
async function rotateSearchIndex() {
  const passKek = Buffer.from(readEnvValue('KEK_PASSPORT_SENSITIVE') ?? '', 'base64');
  const kybKek = Buffer.from(readEnvValue('KEK_KYB_DOCUMENTS') ?? '', 'base64');
  if (passKek.length !== DEK_BYTES || kybKek.length !== DEK_BYTES) {
    console.error(
      'для пересчёта нужны KEK_PASSPORT_SENSITIVE и KEK_KYB_DOCUMENTS (32 байта base64)',
    );
    process.exit(1);
  }
  const lock = mode === 'check' ? '' : ' FOR UPDATE';
  let total = 0;
  let recomputed = 0;
  let bad = 0;
  let outOfPipeline = 0;

  // Валидная конвертная обёртка — ровно IV(12) + TAG(16) + DEK(32) байта.
  // Фикстуры смоуков (`smoke-investments`: '\x00' вместо шифртекста, digest
  // вместо HMAC) в конвейере не участвуют: их blind index не зависит от KEK,
  // и смена ключа их не трогает. Они считаются ОТДЕЛЬНО и печатаются — но не
  // валят ротацию. Повреждённая строка с валидной обёрткой — по-прежнему стоп.
  const WRAP_BYTES = IV_BYTES + TAG_BYTES + DEK_BYTES;

  // identity.users: email_hmac / phone_hmac из контактов (домен passport_sensitive).
  const { rows: users } = await client.query(
    `SELECT id, contact_wrapped_dek, email_ciphertext, phone_ciphertext, email_hmac, phone_hmac
       FROM identity.users WHERE contact_wrapped_dek IS NOT NULL${lock}`,
  );
  for (const u of users) {
    total++;
    if (u.contact_wrapped_dek.length !== WRAP_BYTES) {
      outOfPipeline++;
      continue;
    }
    let dek;
    try {
      dek = decrypt(passKek, u.contact_wrapped_dek, 'wrap:passport_sensitive');
    } catch {
      bad++;
      continue;
    }
    const updates = [];
    let rowOk = true;
    for (const [kind, ct, stored, col] of [
      ['email', u.email_ciphertext, u.email_hmac, 'email_hmac'],
      ['phone', u.phone_ciphertext, u.phone_hmac, 'phone_hmac'],
    ]) {
      if (!ct) continue;
      let plain;
      try {
        plain = decrypt(dek, ct, `field:${kind}`).toString('utf8');
      } catch {
        rowOk = false;
        break;
      }
      if (!stored || !blindIndex(oldKek, plain, kind).equals(stored)) {
        rowOk = false; // старый HMAC не сошёлся — конвейер воспроизведён неверно
        break;
      }
      if (newKek) updates.push([col, blindIndex(newKek, plain, kind)]);
    }
    dek.fill(0);
    if (!rowOk) {
      bad++;
      continue;
    }
    if (newKek && mode !== 'check' && updates.length) {
      const sets = updates.map(([col], i) => `${col} = $${i + 2}`).join(', ');
      await client.query(`UPDATE identity.users SET ${sets} WHERE id = $1`, [
        u.id,
        ...updates.map(([, v]) => v),
      ]);
    }
    if (newKek) recomputed++;
  }
  const usersSkipped = outOfPipeline;
  console.warn(
    `identity.users: строк ${users.length}, в конвейере ${users.length - usersSkipped}, ` +
      `старый HMAC сошёлся у ${users.length - usersSkipped - bad}` +
      (newKek ? `, пересчитано ${recomputed}` : ''),
  );

  // kyc.business_entities: inn_hmac (домен kyb_documents).
  const { rows: entities } = await client.query(
    `SELECT id, entity_wrapped_dek, inn_ciphertext, inn_hmac
       FROM kyc.business_entities WHERE inn_ciphertext IS NOT NULL${lock}`,
  );
  let entRecomputed = 0;
  let entBad = 0;
  for (const e of entities) {
    total++;
    if (e.entity_wrapped_dek.length !== WRAP_BYTES) {
      outOfPipeline++;
      continue;
    }
    let dek;
    let plain;
    try {
      dek = decrypt(kybKek, e.entity_wrapped_dek, 'wrap:kyb_documents');
      plain = decrypt(dek, e.inn_ciphertext, 'field:inn').toString('utf8');
    } catch {
      entBad++;
      continue;
    } finally {
      if (dek) dek.fill(0);
    }
    if (!e.inn_hmac || !blindIndex(oldKek, plain, 'inn').equals(e.inn_hmac)) {
      entBad++;
      continue;
    }
    if (newKek) {
      if (mode !== 'check') {
        await client.query(`UPDATE kyc.business_entities SET inn_hmac = $2 WHERE id = $1`, [
          e.id,
          blindIndex(newKek, plain, 'inn'),
        ]);
      }
      entRecomputed++;
    }
  }
  const entSkipped = outOfPipeline - usersSkipped;
  console.warn(
    `kyc.business_entities: строк ${entities.length}, в конвейере ${entities.length - entSkipped}, ` +
      `старый HMAC сошёлся у ${entities.length - entSkipped - entBad}` +
      (newKek ? `, пересчитано ${entRecomputed}` : ''),
  );
  if (outOfPipeline > 0) {
    console.warn(
      `вне конвейера (обёртка не ${WRAP_BYTES} байт): ${outOfPipeline} строк — фикстуры смоуков, ` +
        'их blind index не зависит от KEK и не трогается; в production таких строк быть не должно',
    );
  }
  console.warn(
    'НЕ пересчитывается: consents.request_trace_hash / user_agent_hash — исходные значения ' +
      'не хранятся; историческая связка с журналом остаётся на прежнем ключе.',
  );

  if (bad + entBad > 0) {
    if (mode !== 'check') await client.query('ROLLBACK');
    console.error(`ОШИБОК: ${bad + entBad} — ротация не выполнена`);
    process.exit(1);
  }
  if (mode === 'test') {
    const { rows: after } = await client.query(
      `SELECT contact_wrapped_dek, email_ciphertext, email_hmac FROM identity.users
        WHERE email_ciphertext IS NOT NULL LIMIT 1`,
    );
    if (after.length) {
      const dek = decrypt(passKek, after[0].contact_wrapped_dek, 'wrap:passport_sensitive');
      const plain = decrypt(dek, after[0].email_ciphertext, 'field:email').toString('utf8');
      dek.fill(0);
      const newOk = blindIndex(newKek, plain, 'email').equals(after[0].email_hmac);
      const oldRejected = !blindIndex(oldKek, plain, 'email').equals(after[0].email_hmac);
      console.warn(
        `контроль записанного: новым ключом сходится — ${newOk ? 'да' : 'НЕТ'}; старым уже не сходится — ${oldRejected ? 'да' : 'НЕТ'}`,
      );
      if (!newOk || !oldRejected) {
        await client.query('ROLLBACK');
        console.error('контроль не пройден — откат');
        process.exit(1);
      }
    }
    await client.query('ROLLBACK');
    console.warn('транзакция откачена: база не изменена');
  } else if (mode === 'apply') {
    await commitWithEnv(`пересчитано ${recomputed + entRecomputed} blind index из ${total} строк`);
  } else {
    console.warn(`итого строк: ${total}, старый ключ воспроизводит все хранимые HMAC`);
  }
}

if (DIRECT_DOMAIN || HMAC_DOMAIN) {
  try {
    if (mode !== 'check') await client.query('BEGIN');
    if (DIRECT_DOMAIN) await rotateWebhookSecrets();
    else await rotateSearchIndex();
  } catch (e) {
    if (mode !== 'check') {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* соединение могло закрыться */
      }
    }
    console.error(`ошибка: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
  process.exit(process.exitCode ?? 0);
}

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
    if (WRITE_ENV) {
      // .env пишем ДО фиксации: если фиксация сорвётся, откатываем и файл, и
      // транзакцию. Иначе возможен разъезд — в базе новые обёртки, в .env
      // старый ключ, и данные не открываются.
      let previousEnv;
      try {
        previousEnv = writeEnvValue(ENV_BY_DOMAIN[domain], newKek.toString('base64'));
      } catch (e) {
        await client.query('ROLLBACK');
        await client.end();
        console.error(`не удалось записать .env: ${e.message} — транзакция откачена`);
        process.exit(1);
      }
      try {
        await client.query('COMMIT');
      } catch (e) {
        writeFileSync(resolve(ROOT, '.env'), previousEnv, 'utf8');
        await client.end();
        console.error(`фиксация не прошла: ${e.message} — .env возвращён к прежнему значению`);
        process.exit(1);
      }
      console.warn('');
      console.warn(`зафиксировано: переобёрнуто ${totalRewrapped} из ${totalRows} строк`);
      console.warn(`${ENV_BY_DOMAIN[domain]}: новое значение записано в .env`);
      console.warn('значение нигде не печаталось — в транскрипт сессии оно не попало');
      console.warn('');
      console.warn('ДАЛЬШЕ: npm run secrets:redactors, затем перезапустить ядро.');
    } else {
      await client.query('COMMIT');
      console.warn('');
      console.warn(`зафиксировано: переобёрнуто ${totalRewrapped} из ${totalRows} строк`);
      console.warn('');
      console.warn('ДАЛЬШЕ, не откладывая:');
      console.warn(`  1) заменить ${ENV_BY_DOMAIN[domain]} в .env на новое значение;`);
      console.warn(
        '  2) npm run secrets:redactors — иначе новый ключ уйдёт в транскрипт открытым;',
      );
      console.warn('  3) перезапустить ядро.');
      console.warn('До шага 1 приложение работает со СТАРЫМ ключом и данные не откроются.');
      if (generated) {
        console.warn('');
        console.warn(`новое значение ${ENV_BY_DOMAIN[domain]} (показывается один раз):`);
        console.warn(newKek.toString('base64'));
      }
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
