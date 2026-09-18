#!/usr/bin/env node
/**
 * Стартовая конфигурация вопросов заявки (версия 1) — из банка вопросов.
 *
 * Источник — `docs/product/каталог-вопросов-заявки.md` (версия 2): таблицы
 * разделов дают ключ, тип, состояния по стадиям, видимость и подтверждение;
 * карточки под таблицами — формулировку, подсказку, примеры и варианты.
 * Результат — `packages/contracts/src/domain/application-form.v1.ts`:
 * документ `ApplicationFormConfig`, которым сид (этап 3.2) публикует версию 1
 * и который остаётся запасным RU-текстом в коде.
 *
 * После первой публикации действующая конфигурация живёт в БД и правится в
 * админке; этот скрипт нужен только для стартовой версии и для проверки, что
 * каталог и код не разошлись до неё.
 *
 * Запуск:  node scripts/build-application-form-v1.mjs [--check]
 *   --check — не писать, а сравнить с существующим файлом (для CI).
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'docs/product/каталог-вопросов-заявки.md');
const TARGET = resolve(ROOT, 'packages/contracts/src/domain/application-form.v1.ts');
const CHECK = process.argv.includes('--check');

const LOCALE = 'ru-RU';
const STAGES = ['idea', 'mvp', 'early_revenue', 'growth'];
const STATE = { M: 'mandatory', 'M¹': 'mandatory', R: 'recommended', '—': 'hidden' };
const ROUND_DISCLOSURE_DEFAULT = new Set(['investment_ask', 'funding_scope', 'funding_scope_note']);
const CORE_FIELDS = new Set([
  'stage',
  'business_type',
  'funding_scope',
  'funding_scope_note',
  'investment_ask',
]);

/** Подписи вариантов, которых в карточках нет словами (§0.2 каталога и коды-имена). */
const OPTION_LABELS = {
  idea: 'Идея',
  mvp: 'MVP',
  early_revenue: 'Первые продажи',
  growth: 'Рост',
  saas: 'Подписка на программный продукт (SaaS)',
  marketplace: 'Маркетплейс или платформа',
  consumer: 'Потребительский продукт (B2C)',
  enterprise: 'Продажи компаниям (enterprise)',
  hardware_deeptech: 'Железо и deeptech',
  regulated_biotech: 'Регулируемая отрасль, биотех, медицина',
  other: 'Другое',
  jira: 'Jira',
  notion: 'Notion',
  trello: 'Trello',
  obsidian: 'Obsidian',
  github_projects: 'GitHub Projects',
  ms_project: 'MS Project',
  mind_maps: 'Интеллект-карты',
  pre_seed: 'Pre-seed',
  seed: 'Seed',
  series_a: 'Серия A',
  series_b_plus: 'Серия B и позже',
};

/** Ограничения — зона разработчика (§0в п.8), в каталоге их нет. */
const CONSTRAINTS = {
  founded_year: { min: 1990, max: 2100 },
  users_total: { min: 0, max: 1_000_000_000 },
  active_users: { min: 0, max: 1_000_000_000 },
  paying_customers: { min: 0, max: 1_000_000_000 },
  runway_current_months: { min: 0, max: 999 },
  runway_with_funds_months: { min: 1, max: 999 },
  gross_margin: { min: 0, max: 100 },
  take_rate: { min: 0, max: 100 },
  demo: { maxItems: 3 },
  pitch_deck: { maxItems: 1 },
  financial_model: { maxItems: 1 },
  other_materials: { maxItems: 20 },
};

const md = readFileSync(SOURCE, 'utf8');
const lines = md.split('\n');

// ------------------------------------------------------------ разделы

const sections = [];
const sectionByKey = new Map();
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(/^## (\d+)\. (.+?) \(`([a-z_]+)`\)$/);
  if (!m) continue;
  const order = Number(m[1]);
  if (order < 1 || order > 14) continue;
  let intro = null;
  for (let j = i + 1; j < lines.length && !lines[j].startsWith('## '); j += 1) {
    if (lines[j].startsWith('**Вводный текст раздела.**')) {
      const buf = [];
      for (let k = j; k < lines.length && lines[k].trim() !== ''; k += 1) buf.push(lines[k].trim());
      intro = buf.join(' ').replace('**Вводный текст раздела.**', '').trim();
      break;
    }
  }
  const section = {
    key: m[3],
    order: order * 10,
    // Раздел раунда (план 0.2 §0г): показывается только при раунде, ответы —
    // в раунде. Остальные разделы — профиль.
    ...(m[3] === 'funding' ? { scope: 'round' } : {}),
    texts: { [LOCALE]: { title: m[2], ...(intro ? { intro_md: intro } : {}) } },
    _questions: [],
  };
  sections.push(section);
  sectionByKey.set(section.key, section);
}
if (sections.length !== 14) throw new Error(`ожидалось 14 разделов, найдено ${sections.length}`);

// ------------------------------------------------------------ таблицы

const rows = new Map();
let currentSection = null;
for (const line of lines) {
  const h = line.match(/^## (\d+)\. .+ \(`([a-z_]+)`\)$/);
  if (h) currentSection = sectionByKey.get(h[2]) ?? null;
  if (!currentSection || !line.startsWith('| `')) continue;
  const cells = line
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
  if (cells.length !== 8) continue;
  const key = cells[0].match(/`([a-z0-9_]+)`/)[1];
  const states = cells.slice(2, 6).map((c) => STATE[c]);
  if (states.some((s) => !s)) throw new Error(`${key}: непонятное состояние в таблице`);
  const rawType = cells[1];
  const type = rawType.replace('⁺', '');
  const constraints = { ...(CONSTRAINTS[key] ?? {}) };
  if (type === 'textarea') constraints.maxLength = rawType.includes('⁺') ? 4000 : 2000;
  if (type === 'text') constraints.maxLength = 200;
  rows.set(key, {
    key,
    section: currentSection.key,
    type,
    stages: Object.fromEntries(STAGES.map((s, i) => [s, states[i]])),
    // Группа «текущий запрос» и предмет финансирования стартуют закрытыми от
    // анонимного посетителя (владелец, 2026-09-18): публичность — явная
    // настройка в админке, не умолчание. Каталог берёт значение из активной
    // конфигурации (M085).
    visibility: ROUND_DISCLOSURE_DEFAULT.has(key) ? 'investors' : cells[6],
    evidence: cells[7] === 'да',
    constraints,
    core: cells[0].includes('core'),
  });
  currentSection._questions.push(key);
}

// ------------------------------------------------------------ карточки

const cards = new Map();
for (let i = 0; i < lines.length; i += 1) {
  const m = lines[i].match(/^\*\*`([a-z0-9_]+)`\*\* — (.*)$/);
  if (!m) continue;
  const key = m[1];
  const labelBuf = [m[2]];
  let j = i + 1;
  while (j < lines.length && lines[j].trim() !== '') {
    labelBuf.push(lines[j].trim());
    j += 1;
  }
  const bullets = {};
  let current = null;
  for (j += 1; j < lines.length; j += 1) {
    const line = lines[j];
    if (line.trim() === '') {
      const next = lines[j + 1] ?? '';
      if (!next.startsWith('- ') && !next.startsWith('  ')) break;
      continue;
    }
    if (line.startsWith('- ')) {
      const b = line.slice(2).match(/^([^:]+):\s*(.*)$/);
      if (!b) throw new Error(`${key}: непонятный пункт «${line}»`);
      current = b[1];
      bullets[current] = b[2];
    } else if (line.startsWith('  ') && current) {
      bullets[current] += ' ' + line.trim();
    } else break;
  }
  cards.set(key, { label: labelBuf.join(' '), bullets });
}

function unquote(text) {
  const t = text.trim();
  return t.startsWith('«') && t.endsWith('».') ? t.slice(1, -2) : t.replace(/^«|»\.?$/g, '');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** «`code` — подпись; `code` — подпись.» → [{code, label}]; подпись может отсутствовать. */
function parseOptions(body) {
  const parts = body.split('`');
  const options = [];
  for (let i = 1; i < parts.length; i += 2) {
    const code = parts[i];
    const rest = parts[i + 1] ?? '';
    const m = rest.match(/^\s*—\s*([^;]*?)\s*(?:;|\.\s*$|\s\(|,\s*$|$)/s);
    const parsed = m && m[1] ? m[1].trim().replace(/[.,]$/, '') : null;
    options.push({ code, label: parsed });
  }
  return options;
}

// ------------------------------------------------------------ сборка

const questions = [];
for (const section of sections) {
  section._questions.forEach((key, index) => {
    const row = rows.get(key);
    const card = cards.get(key);
    if (!card) throw new Error(`${key}: нет карточки под таблицей`);
    const texts = { label: card.label };
    let help = card.bullets['Подсказка'] ?? null;
    let options;
    if (row.type === 'select' || row.type === 'multiselect') {
      const raw = card.bullets['Варианты'];
      if (!raw) throw new Error(`${key}: у select нет вариантов`);
      const parsed = parseOptions(raw);
      if (key === 'stage') {
        // Короткие подписи — в варианты, развёрнутые описания — в подсказку.
        const described = parsed
          .map((o) => `- **${OPTION_LABELS[o.code]}** — ${o.label}`)
          .join('\n');
        help = `${help ?? ''}\n\nКак понимать стадии:\n\n${described}`.trim();
        options = parsed.map((o) => ({
          code: o.code,
          texts: { [LOCALE]: { label: OPTION_LABELS[o.code] } },
        }));
      } else {
        options = parsed.map((o) => {
          const label = o.label ? capitalize(o.label) : OPTION_LABELS[o.code];
          if (!label) throw new Error(`${key}: нет подписи для варианта ${o.code}`);
          return { code: o.code, texts: { [LOCALE]: { label } } };
        });
      }
    }
    if (help) texts.help_md = capitalize(help);
    if (card.bullets['Хороший ответ'])
      texts.example_good_md = unquote(card.bullets['Хороший ответ']);
    if (card.bullets['Слабый ответ']) texts.example_weak_md = unquote(card.bullets['Слабый ответ']);

    const question = {
      key,
      section: section.key,
      order: (index + 1) * 10,
      type: row.type,
      ...(options ? { options } : {}),
      stages: row.stages,
      visibility: row.visibility,
      ...(row.evidence ? { evidence: true } : {}),
      ...(Object.keys(row.constraints).length ? { constraints: row.constraints } : {}),
      ...(CORE_FIELDS.has(key) ? { coreField: key } : {}),
      texts: { [LOCALE]: texts },
    };
    if (row.core !== CORE_FIELDS.has(key)) throw new Error(`${key}: пометка core не совпадает`);
    questions.push(question);
  });
}
if (questions.length !== rows.size) throw new Error('строки таблиц и карточки разошлись');

// previous_funding — история проекта, а не условие текущего привлечения
// (заявка-03 §2.4): инвестору она нужна и без раунда, поэтому вопрос живёт в
// профиле, в конце раздела «Результаты и динамика».
{
  const moved = questions.find((q) => q.key === 'previous_funding');
  if (!moved) throw new Error('нет вопроса previous_funding');
  const last = Math.max(
    0,
    ...questions.filter((q) => q.section === 'traction').map((q) => q.order),
  );
  moved.section = 'traction';
  moved.order = last + 10;
}

const config = {
  locales: [LOCALE],
  defaultLocale: LOCALE,
  // Статус привлечения — отдельная настройка раскрытия (M086), стартово
  // закрыт от анонима, как и сумма.
  disclosure: { raising_status: 'investors' },
  sections: sections.map(({ _questions: _q, ...s }) => s),
  questions,
};

const header = `/**
 * СГЕНЕРИРОВАНО scripts/build-application-form-v1.mjs из
 * docs/product/каталог-вопросов-заявки.md (версия 2). Не править руками:
 * до первой публикации формулировки правятся в каталоге и файл
 * перегенерируется, после — действующая конфигурация живёт в БД и правится
 * в админке, а этот документ остаётся запасным RU-текстом и источником
 * стартовой версии для сида (план 0.2 §0в.5).
 */
import type { ApplicationFormConfig } from './application-form';

export const APPLICATION_FORM_V1: ApplicationFormConfig = `;

const body = `${header}${JSON.stringify(config, null, 2)};\n`;

if (CHECK) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  // Файл в репозитории отформатирован prettier (кавычки, переносы, запятые);
  // сравниваем содержание, а не форматирование.
  const normalize = (s) => s.replace(/["'\s,]/g, '');
  if (normalize(current) !== normalize(body)) {
    console.error('application-form.v1.ts отстаёт от каталога: перегенерируйте без --check');
    process.exit(1);
  }
  process.stdout.write('application-form.v1.ts соответствует каталогу\n');
} else {
  writeFileSync(TARGET, body);
  process.stdout.write(
    `записано ${TARGET}: ${sections.length} разделов, ${questions.length} вопросов\n`,
  );
}
