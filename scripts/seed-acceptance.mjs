#!/usr/bin/env node
/**
 * Обстановка для приёмки владельцем и маршрут к ней.
 *
 * Зачем скрипт, а не «создал руками и записал». Стенд пересоздаётся: базы
 * сбрасываются, демо-данные перезаливаются. Маршрут приёмки, который живёт
 * только в голове, после первого же сброса перестаёт работать, и владелец
 * упирается в «такого пользователя нет» вместо проверки продукта.
 *
 * Что делает:
 *
 *   • заводит (или приводит к известному состоянию) три учётные записи
 *     приёмки — администратор, основатель, инвестор;
 *   • создаёт проект основателя, опубликованный в режиме «все»;
 *   • пишет маршрут с адресами и паролями в `.local/приёмка.md`.
 *
 * **Пароли генерируются и в репозиторий не попадают.** Каталог `.local/`
 * закрыт `.gitignore`: пароль в коде — это секрет в коде, даже если он
 * тестовый (RULES.md §4).
 *
 * Запуск: node scripts/seed-acceptance.mjs
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('Учётные записи приёмки в production не создаются.');
  process.exit(1);
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

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

/** Параметры Argon2id — те же, что в IdentityService. */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** Envelope-шифрование адреса: формат и AAD совпадают с CryptoService. */
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

/** Пароль, который не стыдно вводить руками, и которого нет в репозитории. */
function makePassword() {
  return `Priem-${randomBytes(6).toString('hex')}`;
}

async function upsertUser({ login, displayName, roles, primaryRole }) {
  const email = `${login}@fifth.local`;
  const password = makePassword();
  const hash = await argon2.hash(password, ARGON2_OPTIONS);
  const [found] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);

  let userId = found?.id ?? null;
  if (userId) {
    // Идемпотентность: повторный запуск приводит учётку к известному паролю.
    await sql(
      `UPDATE identity.users SET password_hash = $2, status = 'active', display_name = $3
        WHERE id = $1`,
      [userId, hash, displayName],
    );
  } else {
    const contact = sealContact(email);
    const [created] = await sql(
      `INSERT INTO identity.users
         (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash,
          display_name, primary_role, status, locale, origin)
       VALUES (public.uuid_generate_v7(), $1, $2, $3, $4, $5, $6, 'pending_consents', 'ru-RU',
               'seed_acceptance')
       RETURNING id`,
      [contact.ciphertext, contact.wrappedDek, blindIndex(email), hash, displayName, primaryRole],
    );
    userId = created.id;
    // Акцепты обязательных документов: без них аккаунт не активируется, и
    // фикстура не должна создавать состояние, невозможное в бою.
    await sql(
      `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
       SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale,
              digest('acceptance-seed', 'sha256')
         FROM identity.consent_templates t
        WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
          AND t.kind IN ('platform_rules','tos','pdn','commission_terms')`,
      [userId],
    );
    await sql(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [userId]);
  }

  for (const role of roles) {
    await sql(
      `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, role],
    );
  }
  return { login, email, password, userId, displayName };
}

/** Проект приёмки. Ищется по названию: повторный запуск не плодит копии. */
async function upsertProject(title, ownerId) {
  const [found] = await sql(`SELECT id FROM lab.projects WHERE title = $1 AND deleted_at IS NULL`, [
    title,
  ]);
  if (found) return found.id;
  const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
  const [project] = await sql(
    `INSERT INTO lab.projects
       (id, taxonomy_id, title, tagline, description, stage, status, investment_ask, origin,
        listing_status, listed_at, visibility, visibility_changed_at)
     VALUES (public.uuid_generate_v7(), $1, $2, 'Проект для проверки после 2.1-W05',
             'Описание видно всем, пока проект в режиме «все».', 'growth', 'draft', 5000000,
             'seed_acceptance', 'listed', now(), 'public', now())
     RETURNING id`,
    [taxonomy?.id ?? null, title],
  );
  await sql(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')
     ON CONFLICT DO NOTHING`,
    [project.id, ownerId],
  );
  return project.id;
}

console.warn('\n=== ОБСТАНОВКА ПРИЁМКИ ===\n');

const admin = await upsertUser({
  login: 'priem-admin',
  displayName: 'Приёмка · администратор',
  roles: ['admin'],
  primaryRole: 'founder',
});
const founder = await upsertUser({
  login: 'priem-founder',
  displayName: 'Приёмка · основатель',
  roles: ['founder'],
  primaryRole: 'founder',
});
const investor = await upsertUser({
  login: 'priem-investor',
  displayName: 'Приёмка · инвестор',
  roles: ['investor'],
  primaryRole: 'investor',
});

await upsertProject('Приёмка · проект', founder.userId);

/**
 * Демонстрационный комплект — учётные записи `demo-*` и пять проектов
 * (`fixtures/demo`). Их заводит отдельный скрипт, пароль у них общий и берётся
 * из `.env`. Здесь они только ПЕРЕЧИСЛЯЮТСЯ: владелец пользуется стендом по
 * ним, а список «где и под кем входить» должен быть один, а не два.
 *
 * Если комплект не загружен, строк не будет — и это честнее, чем напечатать
 * логины, под которыми не пустят. Ровно этим и обернулось 2026-09-20: список
 * demo-* жил в заметках, база была пересоздана, комплект никто не перезалил, и
 * вход не работал при верном пароле.
 */
async function demoPeople() {
  const file = join(ROOT, 'fixtures', 'demo', 'people.json');
  if (!existsSync(file)) return { password: null, rows: [] };
  const password = process.env.DEMO_USER_PASSWORD || process.env.DEV_TEST_USER_PASSWORD || null;
  const { people: all } = JSON.parse(readFileSync(file, 'utf8'));
  const rows = [];
  for (const person of all) {
    const [found] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
      blindIndex(`${person.login}@fifth.local`),
    ]);
    if (found) rows.push(person);
  }
  return { password, rows };
}

const demo = await demoPeople();

const people = [admin, founder, investor];
for (const who of people) console.warn(`  ·  ${who.login} — ${who.displayName}`);

const routeDir = join(ROOT, '.local');
mkdirSync(routeDir, { recursive: true });
const routeFile = join(routeDir, 'приёмка.md');

const route = `# Маршрут приёмки — удаление инвестпроцесса, сезонов, экспертизы и ИИ (2.1-W05)

Собран ${new Date().toLocaleString('ru-RU')} командой \`node scripts/seed-acceptance.mjs\`.
Файл лежит вне Git (\`.local/\` закрыт \`.gitignore\`): в нём пароли.

Данные тестовые, стенд локальный. Настоящих денег и внешних отправок нет.

---

## Основной адрес

**${publicUrl('webPublic')}** — с него начинается всё остальное.

| Что                | Адрес                        |
| ------------------ | ---------------------------- |
| Витрина            | ${publicUrl('webPublic')}    |
| Вход               | ${publicUrl('auth')}         |
| Кабинет основателя | ${publicUrl('lab')}          |
| Кабинет инвестора  | ${publicUrl('investor')}     |
| Админка            | ${publicUrl('admin')}        |
| Служебная консоль  | ${publicUrl('console')}      |

Один адрес без портов — это не косметика: страница и API лежат на одном
origin, поэтому сессия работает во всех кабинетах, а изображения проектов не
упираются в политику встраивания.

Админка открывает свою форму входа. Остальные кабинеты формы не содержат и
перенаправляют на приложение входа — это нормально.

---

## После перезагрузки компьютера

\`\`\`
npm run stand:up
\`\`\`

Одна команда: собирает приложения, поднимает контейнеры, накатывает миграции,
запускает ядро, включает единый адрес и проверяет маршруты.
Повторный запуск на работающем стенде безопасен.

Контейнеры Docker поднимаются сами вместе с Docker Desktop
(\`restart: unless-stopped\`); ядро — процесс на хосте, его поднимает эта
команда.

| Команда | Что делает |
| ------- | ---------- |
| \`npm run stand:up\` | поднять всё и проверить |
| \`npm run stand:up -- --no-build\` | то же, но без пересборки (быстрее) |
| \`npm run stand:status\` | что работает, что нет и почему |
| \`npm run stand:down\` | остановить; **данные остаются** |

---

## Учётные записи

Логин можно вводить коротким: домен \`fifth.local\` подставляется сам.

### Обстановка приёмки — у каждого свой пароль

| Логин | Кто | Пароль |
| ----- | --- | ------ |
${people.map((w) => `| \`${w.login}\` | ${w.displayName} | \`${w.password}\` |`).join('\n')}

Пароли переустанавливаются при каждом запуске скрипта.

### Демонстрационный комплект — один пароль на всех

${
  demo.rows.length === 0
    ? [
        'Комплект НЕ загружен: учётных записей `demo-*` в базе нет,',
        'и вход под ними не сработает. Загрузить: `node scripts/seed-demo.mjs load`.',
      ].join(' ')
    : `Пять проектов для ручного прохода. Пароль общий: \`${demo.password ?? '(не задан в .env)'}\`

| Логин | Кто |
| ----- | --- |
${demo.rows.map((d) => `| \`${d.login}\` | ${d.displayName} (${d.roles.join(', ')}) |`).join('\n')}

Пароль берётся из \`DEMO_USER_PASSWORD\` или \`DEV_TEST_USER_PASSWORD\` в \`.env\`.
Перезагрузить комплект: \`node scripts/seed-demo.mjs load\`.`
}

---

## Что смотреть — шесть шагов, минут десять

### 1. Витрина без сезона и тарифов

${publicUrl('webPublic')}

Ожидается: тексты витрины и каталог. Полосы сезона, раздела «Тарифы» и строки
«Раунд открыт / не привлекает» на карточках нет.

### 2. Кабинет основателя

Войти под \`priem-founder\`, открыть **Приёмка · проект**.

Ожидается: карточка проекта с запросом инвестиций, режим видимости, доступ,
изображения, материалы. Ни заявок, ни раунда, ни анализа, ни паспорта, ни
согласий на публичный контур. Кнопка «Новый проект» вместо «Новой заявки».

### 3. Предпросмотр «Как видит инвестор»

На той же странице → «Кто может видеть проект» → «Как видит инвестор».

Ожидается: то же, что видит аноним, — допуска по роли больше нет. В режиме
«Только допущенные инвесторы» — «Эта аудитория проект не видит».

### 4. Кабинет инвестора

Войти под \`priem-investor\`.

Ожидается: пустая оболочка «Кабинет в разработке» и кнопка выхода.

### 5. Админка без удалённых разделов

Войти под \`priem-admin\`.

Ожидается в меню: нет групп «Коммерция», «Заявки и сделки», «Сезон»; в
«Интеграциях» только клиенты Integration API; в «Доступе» нет назначений на
оценку и сопровождение. В выдаче ролей — только администратор, инвестор,
основатель.

### 6. Кабинета эксперта и сотрудника больше нет

Открыть ${publicUrl('webPublic')}expert/ и ${publicUrl('webPublic')}staff/.

Ожидается: адреса не раздаются (витрина вместо кабинета).

---

## Чего в этом маршруте нет

- **Денег и сделок.** Удалены целиком; настоящих перечислений не было и нет.
- **Внешних отправок.** Почта локальная.
- **Удалённого стенда.** Всё локально.

---

## Если что-то не открывается

1. \`npm run stand:status\` — покажет, что именно не работает: контейнеры,
   ядро, собранная статика или маршруты.
2. \`npm run stand:up\` — поднимет недостающее. Повторный запуск на
   работающем стенде безопасен.
3. Учётка не пускает — перезапустить \`node scripts/seed-acceptance.mjs\`:
   пароли переустановятся и попадут в этот файл.
`;

writeFileSync(routeFile, route, 'utf8');
console.warn(`\n  Маршрут записан: ${routeFile}`);
console.warn('  Файл вне Git: каталог .local закрыт .gitignore.\n');

await pool.end();
