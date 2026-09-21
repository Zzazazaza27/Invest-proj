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
 *   • заводит (или приводит к известному состоянию) пять учётных записей
 *     приёмки — администратор, основатель, эксперт, второй эксперт с
 *     заявленным конфликтом интересов, инвестор;
 *   • создаёт два проекта: по одному рецензия уже сдана, по второму ещё нет —
 *     чтобы оба исхода «прекратить доступ» можно было посмотреть сразу;
 *   • пишет маршрут с адресами и паролями в `.local/приёмка.md`.
 *
 * **Пароли генерируются и в репозиторий не попадают.** Каталог `.local/`
 * закрыт `.gitignore`: пароль в коде — это секрет в коде, даже если он
 * тестовый (RULES.md §4).
 *
 * Функциональное полномочие эксперту НЕ выдаётся намеренно: выдать его
 * галочкой — часть того, что принимается.
 *
 * Запуск: node scripts/seed-acceptance.mjs
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createCipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicUrl, PORTS } from './lib/ports.mjs';

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
  const email = `${login}@unicorn.local`;
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
    `INSERT INTO lab.projects (id, taxonomy_id, title, stage, status, investment_ask, origin)
     VALUES (public.uuid_generate_v7(), $1, $2, 'growth', 'expert_review', 5000000,
             'seed_acceptance')
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

async function ensureAssignment(projectId, expertId, { withReview }) {
  const [live] = await sql(
    `SELECT id FROM experts.expert_assignments
      WHERE project_id = $1 AND expert_id = $2 AND purpose = 'review'
        AND access_revoked_at IS NULL`,
    [projectId, expertId],
  );
  if (live) return live.id;

  const id = randomUUID();
  await sql(
    `INSERT INTO experts.expert_assignments
       (id, project_id, expert_id, assigned_reason, purpose, status, due_at)
     VALUES ($1, $2, $3, 'manual', 'review', $4, now() + interval '30 days')`,
    [id, projectId, expertId, withReview ? 'completed' : 'accepted'],
  );
  if (withReview) {
    await sql(
      `INSERT INTO experts.expert_reviews
         (id, assignment_id, rubric_scores_jsonb, comment, recommendation)
       VALUES (public.uuid_generate_v7(), $1,
               '{"team":7,"product":6,"strategy":6,"legal":8,"finmodel":5,"scalability":7}'::jsonb,
               'Рецензия обстановки приёмки: она должна пережить прекращение доступа.',
               'needs_review')`,
      [id],
    );
  }
  return id;
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
const expert = await upsertUser({
  login: 'priem-expert',
  displayName: 'Приёмка · эксперт',
  roles: ['expert'],
  primaryRole: 'founder',
});
const conflicted = await upsertUser({
  login: 'priem-conflict',
  displayName: 'Приёмка · эксперт с конфликтом',
  roles: ['expert'],
  primaryRole: 'founder',
});
const investor = await upsertUser({
  login: 'priem-investor',
  displayName: 'Приёмка · инвестор',
  roles: ['investor'],
  primaryRole: 'investor',
});

for (const who of [expert, conflicted]) {
  await sql(
    `INSERT INTO experts.experts (user_id, expertise_tags) VALUES ($1, ARRAY['fintech'])
     ON CONFLICT (user_id) DO NOTHING`,
    [who.userId],
  );
}

const withReview = await upsertProject('Приёмка · рецензия сдана', founder.userId);
const withoutReview = await upsertProject('Приёмка · рецензии ещё нет', founder.userId);
await ensureAssignment(withReview, expert.userId, { withReview: true });
await ensureAssignment(withoutReview, expert.userId, { withReview: false });

// Конфликт интересов по проекту без рецензии: его увидит форма назначения.
await sql(
  `INSERT INTO experts.expert_conflict_declarations (id, expert_id, project_id, description)
   SELECT public.uuid_generate_v7(), $1, $2, $3
    WHERE NOT EXISTS (
      SELECT 1 FROM experts.expert_conflict_declarations
       WHERE expert_id = $1 AND project_id = $2)`,
  [conflicted.userId, withoutReview, 'Доля в конкурирующем проекте (обстановка приёмки).'],
);

/**
 * Демонстрационный комплект — девять учётных записей `demo-*` и пять проектов
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
      blindIndex(`${person.login}@unicorn.local`),
    ]);
    if (found) rows.push(person);
  }
  return { password, rows };
}

const demo = await demoPeople();

const people = [admin, founder, expert, conflicted, investor];
for (const who of people) console.warn(`  ·  ${who.login} — ${who.displayName}`);

const routeDir = join(ROOT, '.local');
mkdirSync(routeDir, { recursive: true });
const routeFile = join(routeDir, 'приёмка.md');

const route = `# Маршрут приёмки — управление экспертами

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
| Кабинет эксперта   | ${publicUrl('expert')}       |
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
запускает ядро и шлюз анализа, включает единый адрес и проверяет маршруты.
Повторный запуск на работающем стенде безопасен.

Контейнеры Docker поднимаются сами вместе с Docker Desktop
(\`restart: unless-stopped\`); ядро и шлюз — процессы на хосте, их поднимает эта
команда.

| Команда | Что делает |
| ------- | ---------- |
| \`npm run stand:up\` | поднять всё и проверить |
| \`npm run stand:up -- --no-build\` | то же, но без пересборки (быстрее) |
| \`npm run stand:status\` | что работает, что нет и почему |
| \`npm run stand:down\` | остановить; **данные остаются** |

---

## Учётные записи

Логин можно вводить коротким: домен \`unicorn.local\` подставляется сам.

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
    : `Пять проектов и девять ролей для ручного прохода. Пароль общий: \`${demo.password ?? '(не задан в .env)'}\`

| Логин | Кто |
| ----- | --- |
${demo.rows.map((d) => `| \`${d.login}\` | ${d.displayName} (${d.roles.join(', ')}) |`).join('\n')}

Пароль берётся из \`DEMO_USER_PASSWORD\` или \`DEV_TEST_USER_PASSWORD\` в \`.env\`.
Перезагрузить комплект: \`node scripts/seed-demo.mjs load\`.`
}

---

## Что смотреть — восемь шагов, минут пятнадцать

### 1. Каталог полномочий и его границы

Админка → **Доступ** → раздел «Полномочия сотрудника». Найти
\`Приёмка · эксперт\`, выбрать.

Ожидается: один раздел «Финансы» и четыре строки с описанием обычными словами.
Это ВЕСЬ каталог, а не первая порция: остальные разделы платформы работают по
ролевой модели. Рядом с каждым правом — значок «нужно назначение на объект».

### 2. Выдача полномочия галочкой

Заполнить «Основание», поставить галочку «Фиксировать возврат транша».

Ожидается: «Полномочие выдано». Без основания — отказ с объяснением.

### 3. Конфликт интересов виден до попытки работы

Раздел «Назначение на оценку проекта» → проект **Приёмка · рецензии ещё нет**
→ «Кого назначить»: \`Приёмка · эксперт с конфликтом\`.

Ожидается: красное объяснение с датой и текстом заявления, кнопка «Назначить
на оценку» недоступна. Решает по-прежнему сервер — экран лишь показывает то,
чем он ответит.

### 4. Прекращение доступа ПОСЛЕ сданной рецензии

Тот же раздел → проект **Приёмка · рецензия сдана**.

Ожидается в строке назначения: «работа выполнена», «рецензия подана».
Заполнить «Основание прекращения доступа», нажать **Прекратить доступ**.

Ожидается сообщение: «Доступ прекращён. Поданная рецензия осталась —
прекращение доступа работу не отменяет». В строке появляется отметка «доступ
прекращён», а состояние работы остаётся прежним.

### 5. Проверка глазами эксперта

Кабинет эксперта под \`priem-expert\` (через приложение входа).

Ожидается: проекта **Приёмка · рецензия сдана** в списке назначений НЕТ —
доступ закрыт. Проект **Приёмка · рецензии ещё нет** на месте.

### 6. Прекращение доступа ДО рецензии

Вернуться в админку, тот же раздел, проект **Приёмка · рецензии ещё нет** →
**Прекратить доступ**.

Ожидается: назначение закрывается целиком — ждать рецензию больше не от кого.
В кабинете эксперта список назначений пустеет.

### 7. Возврат доступа — только новым назначением

Попробовать назначить того же эксперта на тот же проект заново: срок в
будущем, «Назначить на оценку».

Ожидается: новое назначение создаётся и доступ возвращается. Старая запись о
прекращении остаётся на месте — история не переписывается.

### 8. Ответ 429 не выглядит как выход из аккаунта

Руками это воспроизводится плохо: нужно исчерпать лимит частоты. Смотреть по
снимку автоматического прохода — \`out/render-staff-access/\`, файл с
\`rate-limited-session\` в имени, и рядом \`session-restored\`.

Ожидается на снимке: «Слишком много запросов», прямая фраза «Из аккаунта вы не
вышли», срок повтора и кнопка «Проверить ещё раз». Из аккаунта не выбрасывает,
введённое не стирает.

---

## Чего в этом маршруте нет

- **Денег.** Проверка денежного действия (запись о возврате транша) есть в
  автоматическом проходе: \`node scripts/render-check-staff-access.mjs\`.
  Реальных перечислений платформа не делает вовсе.
- **Внешних отправок.** Почта локальная, платёжный оператор не подключён.
- **Удалённого стенда.** Всё локально.

---

## Если что-то не открывается

1. \`npm run stand:status\` — покажет, что именно не работает: контейнеры,
   ядро, шлюз анализа (:${PORTS.aiGateway}), собранная статика или маршруты.
2. \`npm run stand:up\` — поднимет недостающее. Повторный запуск на
   работающем стенде безопасен.
3. Учётка не пускает — перезапустить \`node scripts/seed-acceptance.mjs\`:
   пароли переустановятся и попадут в этот файл.
`;

writeFileSync(routeFile, route, 'utf8');
console.warn(`\n  Маршрут записан: ${routeFile}`);
console.warn('  Файл вне Git: каталог .local закрыт .gitignore.\n');

await pool.end();
