#!/usr/bin/env node
/**
 * Восстановимый комплект демонстрационных данных Пятый элемент.
 *
 * Задача не в том, чтобы «налить данных один раз». Комплект должен полностью
 * восстанавливать наполнение после переустановки приложения, очистки БД или
 * развёртывания нового окружения — поэтому исходные данные лежат ФАЙЛАМИ в
 * `fixtures/demo/`, а этот скрипт только переносит их в систему.
 *
 * Команды:
 *   node scripts/seed-demo.mjs load     загрузить (по умолчанию)
 *   node scripts/seed-demo.mjs clean    удалить ТОЛЬКО демонстрационные данные
 *   node scripts/seed-demo.mjs status   что сейчас загружено
 *
 * ЧЕТЫРЕ СВОЙСТВА, РАДИ КОТОРЫХ ОН УСТРОЕН ИМЕННО ТАК.
 *
 * 1. ВОСПРОИЗВОДИМОСТЬ. Все идентификаторы выводятся из фиксированного
 *    пространства имён и ключа сущности (UUIDv5). Один и тот же комплект на
 *    любой машине даёт одни и те же идентификаторы — значит, ссылки в
 *    заметках, скриншотах и отчётах не протухают при пересоздании базы.
 *
 * 2. ИДЕМПОТЕНТНОСТЬ. Отсюда же следует, что повторный запуск не плодит
 *    дубликаты: вставка идёт `ON CONFLICT (id) DO NOTHING`. Случайные
 *    идентификаторы потребовали бы «поиска похожего» — а это и есть источник
 *    вторых копий.
 *
 * 3. ТОЧНАЯ УБОРКА. `clean` удаляет строки ПО ЭТИМ ЖЕ идентификаторам, а не
 *    «всё, что похоже на тестовое». Ни одна чужая строка под уборку не
 *    попадает по построению.
 *
 * 4. НЕ В PRODUCTION. Скрипт отказывается работать при `NODE_ENV=production`
 *    первой же строкой. Демонстрационные проекты в боевом каталоге — это не
 *    «мусор», а ложные инвестиционные предложения.
 *
 * Требуется: БД (`DATABASE_URL_OWNER`) и объектное хранилище (`S3_*`) для
 * файлов материалов. Ядро для загрузки НЕ нужно.
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { s3Object, storageFromEnv } from './lib/s3.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Комплект данных: `fixtures/<набор>/`.
 *
 * Наборов больше одного: `demo` — пять проектов со сквозными сценариями для
 * ручного прохода, `catalog` — сотня карточек для наполнения каталога. Ключи
 * внутри наборов не пересекаются, поэтому идентификаторы остаются
 * детерминированными, а уборка (`clean --set <набор>`) снимает ровно свой
 * комплект и не трогает чужой.
 */
const SET_ARG = process.argv.find((a) => a.startsWith('--set='))?.slice('--set='.length);
const SET_POSITIONAL =
  process.argv.indexOf('--set') >= 0 ? process.argv[process.argv.indexOf('--set') + 1] : undefined;
const FIXTURE_SET = SET_ARG ?? SET_POSITIONAL ?? 'demo';
if (!/^[a-z0-9-]+$/.test(FIXTURE_SET)) {
  console.error(`недопустимое имя набора «${FIXTURE_SET}»: только строчные буквы, цифры и дефис`);
  process.exit(1);
}
const FIXTURES = join(ROOT, 'fixtures', FIXTURE_SET);
if (!existsSync(FIXTURES)) {
  console.error(`набора «${FIXTURE_SET}» нет: ожидался каталог ${FIXTURES}`);
  process.exit(1);
}

loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('seed-demo не работает в production: демонстрационные проекты в боевом');
  console.error('каталоге — это ложные инвестиционные предложения, а не мусор.');
  process.exit(1);
}

const COMMAND = process.argv[2] ?? 'load';
if (!['load', 'clean', 'status'].includes(COMMAND)) {
  console.error(`неизвестная команда «${COMMAND}»; допустимы: load, clean, status`);
  process.exit(1);
}

/**
 * Пространство имён комплекта.
 *
 * Меняется только вместе с решением «это другой комплект»: смена строки
 * означает, что старые данные перестают опознаваться уборкой и остаются в базе
 * навсегда.
 */
const NAMESPACE = 'unicorn-launch/demo/v1';

/** UUIDv5 из пространства имён и имени сущности. Детерминированный и стабильный. */
function demoId(...parts) {
  const hash = createHash('sha1')
    .update(`${NAMESPACE}|${parts.join('|')}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // версия 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // вариант RFC 4122
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

const people = JSON.parse(readFileSync(join(FIXTURES, 'people.json'), 'utf8')).people;
const projects = JSON.parse(readFileSync(join(FIXTURES, 'projects.json'), 'utf8')).projects;

/**
 * Пароль демонстрационных учётных записей.
 *
 * В репозитории его нет и быть не может — даже «всего лишь демонстрационного»:
 * пароль в репозитории это пароль, который утёк.
 */
const PASSWORD = process.env.DEMO_USER_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD ?? '';

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

function blindIndex(value) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${value.trim().toLowerCase()}`, 'utf8')
    .digest();
}

/** Envelope-шифрование адреса: формат и AAD совпадают с CryptoService ядра. */
function sealContact(email) {
  const kek = Buffer.from(process.env.KEK_PASSPORT_SENSITIVE ?? '', 'base64');
  if (kek.length !== 32) throw new Error('KEK_PASSPORT_SENSITIVE не задан или неверной длины');
  const dek = randomBytes(32);
  const encrypt = (key, plaintext, aad) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const ciphertext = encrypt(dek, Buffer.from(email, 'utf8'), 'field:email');
  const wrappedDek = encrypt(kek, dek, 'wrap:passport_sensitive');
  dek.fill(0);
  return { ciphertext, wrappedDek };
}

const userId = (key) => demoId('user', key);
const projectId = (key) => demoId('project', key);

// ---------------------------------------------------------------------- статус

async function status() {
  const [row] = await sql(
    `SELECT
       (SELECT count(*) FROM identity.users        WHERE id = ANY($1::uuid[])) AS users,
       (SELECT count(*) FROM lab.projects          WHERE id = ANY($2::uuid[])) AS projects,
       (SELECT count(*) FROM lab.project_materials WHERE project_id = ANY($2::uuid[])) AS materials`,
    [people.map((p) => userId(p.key)), projects.map((p) => projectId(p.key))],
  );
  console.warn('\n=== КОМПЛЕКТ ДЕМОНСТРАЦИОННЫХ ДАННЫХ ===\n');
  console.warn(`  пространство имён: ${NAMESPACE}`);
  console.warn(`  учётных записей:   ${row.users} из ${people.length}`);
  console.warn(`  проектов:          ${row.projects} из ${projects.length}`);
  console.warn(`  материалов:        ${row.materials}`);
  console.warn('');
}

// ----------------------------------------------------------------------- уборка

async function clean() {
  const uids = people.map((p) => userId(p.key));
  const pids = projects.map((p) => projectId(p.key));

  console.warn('\n=== УБОРКА ДЕМОНСТРАЦИОННЫХ ДАННЫХ ===\n');

  // Порядок обратный порядку создания: сначала то, что ссылается, потом то,
  // на что ссылаются. Внешние ключи здесь не «мешают» — они и есть проверка
  // того, что уборка полна.
  const steps = [
    ['избранное', `DELETE FROM lab.project_favorites WHERE user_id = ANY($1::uuid[])`, [uids]],
    [
      'сообщения обращений',
      `DELETE FROM comms.support_messages WHERE ticket_id IN
         (SELECT id FROM comms.support_tickets WHERE user_id = ANY($1::uuid[]))`,
      [uids],
    ],
    ['обращения', `DELETE FROM comms.support_tickets WHERE user_id = ANY($1::uuid[])`, [uids]],
    ['уведомления', `DELETE FROM comms.notifications WHERE user_id = ANY($1::uuid[])`, [uids]],
    [
      'настройки уведомлений',
      `DELETE FROM comms.notification_preferences WHERE user_id = ANY($1::uuid[])`,
      [uids],
    ],
    ['материалы', `DELETE FROM lab.project_materials WHERE project_id = ANY($1::uuid[])`, [pids]],
  ];

  for (const [label, statement, params] of steps) {
    const { rowCount } = await pool.query(statement, params);
    console.warn(`  ${String(rowCount).padStart(4)} ${label}`);
  }

  // Акцепт документов append-only ПО ЗАМЫСЛУ, и это правильный замысел:
  // согласие, которое можно стереть, юридически не является согласием.
  // Ровно поэтому же триггер не даёт убрать и демонстрационные строки.
  // Здесь триггер снимается на время удаления и возвращается сразу же, в
  // `finally`. Это операция ВЛАДЕЛЬЦА схемы на НЕ-production базе (проверено
  // первой строкой файла) — в бою этот путь недостижим, и append-only там
  // остаётся безусловным.
  const APPEND_ONLY = [
    [
      'identity.consents',
      'consents_immutable',
      'согласия',
      `DELETE FROM identity.consents WHERE user_id = ANY($1::uuid[])`,
      uids,
    ],
  ];
  for (const [table, trigger, label, statement, params] of APPEND_ONLY) {
    await pool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    try {
      const { rowCount } = await pool.query(statement, [params]);
      console.warn(`  ${String(rowCount).padStart(4)} ${label}`);
    } finally {
      await pool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    }
  }

  const rest = [
    [
      'участники проектов',
      `DELETE FROM lab.founders_projects WHERE project_id = ANY($1::uuid[])`,
      [pids],
    ],
    ['проекты', `DELETE FROM lab.projects WHERE id = ANY($1::uuid[])`, [pids]],
    ['роли', `DELETE FROM identity.user_roles WHERE user_id = ANY($1::uuid[])`, [uids]],
    ['учётные записи', `DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [uids]],
  ];
  for (const [label, statement, params] of rest) {
    const { rowCount } = await pool.query(statement, params);
    console.warn(`  ${String(rowCount).padStart(4)} ${label}`);
  }

  // Файлы материалов. Хранилище может быть не настроено — это не ошибка
  // уборки базы, но и молчать нельзя: файлы останутся.
  const storage = storageFromEnv();
  if (!storage) {
    console.warn('\n  ВНИМАНИЕ: хранилище не настроено — файлы материалов НЕ удалены.');
  } else {
    let removed = 0;
    for (const project of projects) {
      for (const material of project.materials ?? []) {
        if (material.type === 'product_link') continue;
        const key = materialKey(projectId(project.key), material);
        const response = await s3Object(storage, 'DELETE', key);
        if (response.ok || response.status === 404) removed += 1;
      }
    }
    console.warn(`  ${String(removed).padStart(4)} файлов материалов`);
  }

  console.warn('\nУбрано. Чужие строки не затронуты: удаление шло по идентификаторам комплекта.\n');
}

/** Ключ объекта совпадает с тем, что строит ядро (`S3Service.buildMaterialKey`). */
function materialKey(project, material) {
  return `projects/${project}/materials/${material.type}/${demoId('material', project, material.type)}`;
}

// --------------------------------------------------------------------- загрузка

async function upsertPerson(person) {
  const id = userId(person.key);
  const email = `${person.login}@fifth.local`;
  const hash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);
  const contact = sealContact(email);

  // Идентификатор детерминирован, поэтому повторный запуск не создаёт вторую
  // запись. Пароль обновляется всегда: он мог быть ротирован после первой
  // загрузки, и «учётка есть, но пароль другой» — худший из исходов.
  await sql(
    `INSERT INTO identity.users
       (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash,
        display_name, primary_role, status, locale, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_consents', 'ru-RU', 'seed_demo')
     ON CONFLICT (id) DO UPDATE SET password_hash       = EXCLUDED.password_hash,
                                    display_name        = EXCLUDED.display_name,
                                    email_ciphertext    = EXCLUDED.email_ciphertext,
                                    contact_wrapped_dek = EXCLUDED.contact_wrapped_dek,
                                    email_hmac          = EXCLUDED.email_hmac`,
    [
      id,
      contact.ciphertext,
      contact.wrappedDek,
      blindIndex(email),
      hash,
      person.displayName,
      person.primaryRole,
    ],
  );

  // Согласия обязательны: без всех четырёх действующих документов вход
  // приводит человека на экран повторного акцепта, а не в кабинет.
  // По одной строке на документ: идентификатор детерминирован, а один
  // идентификатор на четыре согласия дал бы три потерянных строки.
  for (const kind of ['platform_rules', 'tos', 'pdn', 'commission_terms']) {
    await sql(
      `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
       SELECT $3, $1, t.kind, t.version, t.locale, digest('seed-demo', 'sha256')
         FROM identity.consent_templates t
        WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU' AND t.kind = $2
       ON CONFLICT (id) DO NOTHING`,
      [id, kind, demoId('consent', person.key, kind)],
    );
  }
  await sql(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [id]);

  for (const role of person.roles) {
    await sql(
      `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [id, role],
    );
  }
  return { ...person, id, email };
}

async function load() {
  if (!PASSWORD) {
    console.error('Не задан пароль демонстрационных учётных записей.');
    console.error('Задайте DEMO_USER_PASSWORD или DEV_TEST_USER_PASSWORD в .env.');
    process.exit(1);
  }

  console.warn('\n=== ЗАГРУЗКА ДЕМОНСТРАЦИОННЫХ ДАННЫХ ===\n');

  // --- люди
  const byKey = new Map();
  for (const person of people) {
    byKey.set(person.key, await upsertPerson(person));
  }
  console.warn(`  учётных записей: ${byKey.size}`);

  // --- проекты
  const storage = storageFromEnv();
  if (!storage) {
    console.warn('  ВНИМАНИЕ: хранилище не настроено — файлы материалов пропущены.');
  }

  for (const project of projects) {
    const id = projectId(project.key);
    const founder = byKey.get(project.founder);
    if (!founder) throw new Error(`в people.json нет ключа «${project.founder}»`);

    const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = $1`, [
      project.taxonomy,
    ]);
    if (!taxonomy) throw new Error(`в таксономии нет направления «${project.taxonomy}»`);

    await sql(
      `INSERT INTO lab.projects
         (id, taxonomy_id, title, tagline, description, stage,
          geo_country, geo_region, investment_ask, status, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'seed_demo')
       ON CONFLICT (id) DO UPDATE SET title       = EXCLUDED.title,
                                      tagline     = EXCLUDED.tagline,
                                      description = EXCLUDED.description,
                                      status      = EXCLUDED.status,
                                      -- Повторная загрузка чинит и происхождение:
                                      -- иначе проекты, заведённые до M127, навсегда
                                      -- остались бы «обычной регистрацией».
                                      origin      = EXCLUDED.origin`,
      [
        id,
        taxonomy.id,
        project.title,
        project.tagline,
        project.description,
        project.stage,
        project.geoCountry,
        project.geoRegion,
        project.investmentAsk,
        project.status,
      ],
    );

    await sql(
      `INSERT INTO lab.founders_projects (project_id, user_id, role)
       VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
      [id, founder.id],
    );

    // Материалы: файл сначала в хранилище, потом строка в базе. Обратный
    // порядок дал бы запись о материале, за которой нет файла, — ровно то
    // состояние, которое инварианты M047 и запрещают.
    for (const material of project.materials ?? []) {
      const materialId = demoId('material', id, material.type);
      if (material.type === 'product_link') {
        await sql(
          `INSERT INTO lab.project_materials
             (id, project_id, type, version, url, uploaded_by, uploaded_at)
           VALUES ($1, $2, 'product_link', 1, $3, $4, now())
           ON CONFLICT (id) DO NOTHING`,
          [materialId, id, material.url, founder.id],
        );
        continue;
      }
      if (!storage) continue;

      const filePath = join(FIXTURES, 'files', material.file);
      if (!existsSync(filePath)) throw new Error(`нет файла материала: ${material.file}`);
      const body = readFileSync(filePath);
      const key = materialKey(id, material);

      const put = await s3Object(storage, 'PUT', key, body, {
        'content-type': material.contentType,
      });
      if (!put.ok) throw new Error(`загрузка ${material.file}: HTTP ${put.status}`);

      // Отпечаток и размер берутся из ФАЙЛА, а не из намерения: инвариант
      // «подтверждённый материал имеет размер» проверяет именно их.
      const sha256 = createHash('sha256').update(body).digest('hex');
      await sql(
        `INSERT INTO lab.project_materials
           (id, project_id, type, version, s3_key, upload_state, uploaded_by,
            uploaded_at, size_bytes, content_hash)
         VALUES ($1, $2, $3, 1, $4, 'ready', $5, now(), $6, $7)
         ON CONFLICT (id) DO UPDATE SET size_bytes = EXCLUDED.size_bytes,
                                        content_hash = EXCLUDED.content_hash`,
        [materialId, id, material.type, key, founder.id, body.length, sha256],
      );
    }

    // Листинг — следствие режима видимости.
    if (project.listingStatus === 'listed') {
      await sql(
        `UPDATE lab.projects
            SET listing_status = 'listed',
                listed_at = coalesce(listed_at, now() - interval '10 days'),
                visibility = 'public',
                visibility_changed_at = coalesce(visibility_changed_at, now())
          WHERE id = $1`,
        [id],
      );
    } else {
      await sql(`UPDATE lab.projects SET listing_status = $2 WHERE id = $1`, [
        id,
        project.listingStatus,
      ]);
    }
  }
  console.warn(`  проектов: ${projects.length}`);

  /**
   * Сквозные сценарии поверх проектов собираются только там, где для них есть
   * персонажи. Набор `demo` держит пятёрку проектов с инвестором — на них
   * проходят именные сценарии избранного и поддержки. Набор `catalog`
   * именных сценариев не имеет: там сотня карточек без заранее расписанных
   * ролей в сюжете. Экспертиза, подписки и сезон удалены в 2.1-W05.
   */
  const investor = byKey.get('investor-active');
  if (!investor) return;

  // --- избранное инвестора
  for (const key of ['aeroseed', 'tochka']) {
    await sql(
      `INSERT INTO lab.project_favorites (user_id, project_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [investor.id, projectId(key)],
    );
  }

  // --- поддержка: обращение и сообщение об ошибке
  const trial = byKey.get('investor-trial');
  const tickets = [
    {
      key: 'support-1',
      kind: 'support',
      subject: 'Как владелец открывает мне свой проект',
      body: 'Вижу тизеры проектов, но описание и материалы закрыты. Подскажите, как получить к ним доступ.',
      context: {},
    },
    {
      key: 'bug-1',
      kind: 'bug_report',
      subject: 'Фильтр по стадии сбрасывается при переходе на вторую страницу',
      body: 'Выбрал стадию «MVP», пролистал каталог — на второй странице снова показываются все проекты.',
      context: {
        url: 'https://demo.fifth.local/investor/catalog',
        viewport: '1440x900',
        locale: 'ru-RU',
        appVersion: 'demo',
        occurredAt: new Date('2026-08-20T09:14:00Z').toISOString(),
        roles: ['investor'],
      },
    },
  ];
  for (const ticket of tickets) {
    await sql(
      `INSERT INTO comms.support_tickets (id, user_id, kind, subject, context_jsonb)
       VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (id) DO NOTHING`,
      [
        demoId('ticket', ticket.key),
        trial.id,
        ticket.kind,
        ticket.subject,
        JSON.stringify(ticket.context),
      ],
    );
    await sql(
      `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
       VALUES ($1, $2, $3, 'user', $4) ON CONFLICT (id) DO NOTHING`,
      [demoId('message', ticket.key), demoId('ticket', ticket.key), trial.id, ticket.body],
    );
  }
  await sql(
    `INSERT INTO comms.support_messages (id, ticket_id, author_id, author_kind, body)
     VALUES ($1, $2, $3, 'staff', $4) ON CONFLICT (id) DO NOTHING`,
    [
      demoId('message', 'support-1-staff'),
      demoId('ticket', 'support-1'),
      byKey.get('admin').id,
      'Описание и материалы открывает владелец проекта: он выдаёт доступ по адресу вашей учётной записи.',
    ],
  );
  await sql(
    `UPDATE comms.support_tickets SET status = 'in_progress', assigned_to = $2 WHERE id = $1`,
    [demoId('ticket', 'support-1'), byKey.get('admin').id],
  );

  console.warn('  сценарии: избранное, поддержка');
  console.warn('\nГотово. Учётные записи:\n');
  for (const person of people) {
    console.warn(
      `  ${person.login.padEnd(22)} ${person.roles.join(', ').padEnd(10)} ${person.displayName}`,
    );
  }
  console.warn('\n  Пароль — из DEMO_USER_PASSWORD (или DEV_TEST_USER_PASSWORD) в .env.\n');
}

try {
  if (COMMAND === 'load') await load();
  else if (COMMAND === 'clean') await clean();
  await status();
} finally {
  await pool.end();
}
