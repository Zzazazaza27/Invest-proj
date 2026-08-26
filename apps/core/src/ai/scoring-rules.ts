import { randomBytes } from 'node:crypto';
import {
  ReadinessDimensionSchema,
  ScoreAxisSchema,
  type CapRule,
  type Passport,
  type PenaltyRule,
  type ScoreAxis,
} from '@unicorn/contracts';

/**
 * То, что считает КОД, а не модель (ADR-008 §3, promt_aiscoring.md раздел 8).
 *
 * Промпт — инструкция, а не механизм контроля. Всё, что здесь, — чистые
 * функции без ввода-вывода: их можно перебрать полностью в тестах, и именно
 * так проверена таблица баллов (все достижимые значения IRS на сетке 5).
 */

/** Веса осей `v0.1-heuristic`. Не меняются: иначе история паспортов несравнима. */
export const AXIS_WEIGHTS: Record<ScoreAxis, number> = {
  market: 0.15,
  demand: 0.15,
  competitive_edge: 0.1,
  uniqueness: 0.1,
  profitability: 0.1,
  presentation_quality: 0.05,
  scalability: 0.15,
  investment_readiness: 0.1,
  product_readiness: 0.1,
};

export type Stage = 'idea' | 'mvp' | 'early_revenue' | 'growth';

/** Расхождение IRS модели с пересчитанным, выше которого — запись в журнал. */
export const IRS_DISCREPANCY_TOLERANCE = 0.5;

// ------------------------------------------------------------------ IRS

/** Взвешенная сумма осей, один знак после запятой. */
export function computeIrs(scores: { axis: string; value: number }[]): number {
  let sum = 0;
  for (const score of scores) {
    const weight = AXIS_WEIGHTS[score.axis as ScoreAxis];
    if (weight === undefined) throw new Error(`неизвестная ось: ${score.axis}`);
    sum += score.value * weight;
  }
  return Math.round(sum * 10) / 10;
}

/** Разбор IRS в форме `irsBreakdown` — из пересчёта, а не из эха модели. */
export function buildIrsBreakdown(
  scores: { axis: string; value: number }[],
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const score of scores) {
    const axis = score.axis as ScoreAxis;
    breakdown[axis] = score.value;
    breakdown[`${axis}_w`] = Math.round(score.value * AXIS_WEIGHTS[axis] * 100) / 100;
  }
  breakdown.sum = computeIrs(scores);
  return breakdown;
}

// ------------------------------------------------------------------ балл 1–10

/**
 * Таблица полуинтервалов `lo ≤ IRS < hi`. Целочисленные диапазоны оставляли
 * дыры на полуцелых значениях: шаг взвешенной суммы при сетке 5 равен 0,25.
 */
const SCORE_TABLE: readonly [number, number][] = [
  [82, 10],
  [74, 9],
  [66, 8],
  [58, 7],
  [50, 6],
  [42, 5],
  [33, 4],
  [24, 3],
  [13, 2],
  [0, 1],
];

export function score10FromIrs(irs: number): number {
  for (const [lo, score] of SCORE_TABLE) {
    if (irs >= lo) return score;
  }
  return 1;
}

/**
 * Значение потолка по коду правила и стадии — из таблицы промпта, а не из
 * числа, присланного моделью. `null` — потолок к этой стадии не применяется.
 */
export function capValue(rule: CapRule, stage: Stage): number | null {
  switch (rule) {
    case 'no_verifiable_activity_claims':
      return stage === 'idea' ? 7 : 5;
    case 'business_model_missing':
    case 'numbers_contradict':
      return 4;
    case 'no_product_customer_money':
      return 3;
    case 'legal_form_missing':
      return stage === 'idea' || stage === 'mvp' ? 8 : 7;
    case 'ask_without_use_of_funds':
      return 7;
  }
}

export interface Score10Result {
  base: number;
  proposed: number;
  /** Потолки с пересчитанным значением; расхождение с моделью — в discrepancies. */
  caps: { rule: CapRule; cap: number }[];
  penalties: PenaltyRule[];
  discrepancies: string[];
}

/**
 * Порядок применения — строго по промпту:
 *   1) базовый балл по таблице;
 *   2) балл = min(базовый, самый строгий сработавший потолок);
 *   3) штрафы, суммарно не более −2, но не ниже 1.
 */
export function computeScore10(
  irs: number,
  stage: Stage,
  caps: { rule: CapRule; cap: number }[],
  penalties: PenaltyRule[],
): Score10Result {
  const discrepancies: string[] = [];
  const base = score10FromIrs(irs);

  const effectiveCaps: { rule: CapRule; cap: number }[] = [];
  for (const cap of caps) {
    const expected = capValue(cap.rule, stage);
    if (expected === null) {
      discrepancies.push(`потолок ${cap.rule} не применяется к стадии ${stage}`);
      continue;
    }
    if (expected !== cap.cap) {
      discrepancies.push(`потолок ${cap.rule}: модель ${cap.cap}, таблица ${expected}`);
    }
    effectiveCaps.push({ rule: cap.rule, cap: expected });
  }

  const strictest = effectiveCaps.reduce((min, c) => Math.min(min, c.cap), base);
  const uniquePenalties = [...new Set(penalties)];
  const penalty = Math.min(2, uniquePenalties.length);
  const proposed = Math.max(1, strictest - penalty);

  return { base, proposed, caps: effectiveCaps, penalties: uniquePenalties, discrepancies };
}

// ------------------------------------------------------------------ полнота

/** Ровно 13 уникальных измерений: схема требует лишь уникальности. */
export function assertReadinessComplete(entries: { dimension: string }[]): void {
  const expected = ReadinessDimensionSchema.options;
  const seen = new Set(entries.map((e) => e.dimension));
  const missing = expected.filter((d) => !seen.has(d));
  if (missing.length > 0 || seen.size !== expected.length || entries.length !== expected.length) {
    throw new Error(
      `карта готовности неполна: ${entries.length} из ${expected.length}` +
        (missing.length ? `, нет ${missing.join(', ')}` : ''),
    );
  }
}

/** Ровно девять осей, каждая один раз. */
export function assertAxesComplete(scores: { axis: string }[]): void {
  const expected = ScoreAxisSchema.options;
  const seen = new Set(scores.map((s) => s.axis));
  if (seen.size !== expected.length || scores.length !== expected.length) {
    throw new Error(
      `оси оценок: ${scores.length} строк, ${seen.size} уникальных из ${expected.length}`,
    );
  }
}

// ------------------------------------------------------------------ nonce и маркеры

/** 128-битный nonce на прогон: маркеры слота опубликованы, nonce — нет. */
export function newNonce(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Шаблоны маркеров слота данных. Заявитель мог закрыть слот своей строкой и
 * продолжить текст «снаружи»: все такие вхождения вырезаются до подстановки —
 * с любым nonce, с двоеточием и без, с произвольным хвостом.
 */
const MARKER_PATTERNS: RegExp[] = [
  /<{3}\s*(?:ЗАЯВКА|СПРАВОЧНЫЕ\s+ДАННЫЕ|ТЕКСТ)[^\n]*/giu,
  /(?:ЗАЯВКА|СПРАВОЧНЫЕ\s+ДАННЫЕ|ТЕКСТ)\s*:?[^\n]*?>{3}/giu,
  /<{3}[^\n]*?>{3}/gu,
];

export function stripSlotMarkers(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = text;
  for (const pattern of MARKER_PATTERNS) {
    out = out.replace(pattern, () => {
      removed += 1;
      return ' ';
    });
  }
  return { text: out, removed };
}

// ------------------------------------------------------------------ egress-фильтр

/**
 * Фильтр публикуемых полей ПЕРЕД записью в БД (promt_aiscoring.md, раздел 8
 * п. 6). Порядок: NFKC → удаление Cc/Cf → поиск URL, разметки, персональных
 * данных. Срабатывание — ОТКАЗ с названной причиной: тихая правка прячет сам
 * факт того, что модель вернула то, чего не должна.
 */
export class EgressViolation extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`egress: ${field}: ${reason}`);
    this.name = 'EgressViolation';
  }
}

const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/iu;
const MARKUP_PATTERN =
  /<\/?[a-z][^>]*>|!\[[^\]]*\]\(|\]\([^)]*\)|^\s*#{1,6}\s|(?:\*\*|__)[^*_]+(?:\*\*|__)/imu;
// Персональные данные: телефон РФ/международный, e-mail, ИНН (10/12 цифр
// отдельным словом), СНИЛС (ддд-ддд-ддд дд), паспорт РФ (серия 4 + номер 6).
const PHONE_PATTERN =
  /(?:^|[^\d])(?:\+7|8|\+\d{1,3})[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/u;
const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.-]+/u;
const INN_PATTERN = /(?:^|\D)(?:\d{10}|\d{12})(?!\d)/u;
const SNILS_PATTERN = /\b\d{3}-\d{3}-\d{3}[\s-]\d{2}\b/u;
// Паспорт — только с разделителями: сплошные десять цифр — это ИНН, не серия+номер.
const RU_PASSPORT_PATTERN = /\b\d{2}\s\d{2}\s\d{6}\b|\b\d{4}\s\d{6}\b/u;

export function normalizeForEgress(value: string): string {
  return value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '');
}

export function checkEgressField(field: string, value: string): string {
  const normalized = normalizeForEgress(value);
  if (URL_PATTERN.test(normalized)) throw new EgressViolation(field, 'ссылка');
  if (MARKUP_PATTERN.test(normalized)) throw new EgressViolation(field, 'разметка');
  if (EMAIL_PATTERN.test(normalized)) throw new EgressViolation(field, 'адрес почты');
  if (PHONE_PATTERN.test(normalized)) throw new EgressViolation(field, 'телефон');
  if (SNILS_PATTERN.test(normalized)) throw new EgressViolation(field, 'СНИЛС');
  if (RU_PASSPORT_PATTERN.test(normalized)) throw new EgressViolation(field, 'паспорт');
  if (INN_PATTERN.test(normalized)) throw new EgressViolation(field, 'ИНН');
  if (normalized !== value.normalize('NFKC')) {
    throw new EgressViolation(field, 'невидимые символы');
  }
  return normalized;
}

/** Все публикуемые строковые поля паспорта, оценок, карты и роадмапа. */
export function checkEgress(input: {
  passport: Passport;
  scores: { axis: string; explanation: string }[];
  readiness: { dimension: string; recommendations: string[] }[];
  roadmap: { title: string; description: string }[];
}): void {
  const p = input.passport;
  checkEgressField('passport.verdict', p.verdict);
  checkEgressField('passport.businessModel', p.businessModel);
  checkEgressField('passport.askSanity', p.askSanity);
  checkEgressField('passport.investorExit', p.investorExit);
  p.strengths.forEach((s, i) => checkEgressField(`passport.strengths[${i}]`, s));
  p.weaknesses.forEach((s, i) => checkEgressField(`passport.weaknesses[${i}]`, s));
  p.risks.forEach((r, i) => {
    checkEgressField(`passport.risks[${i}].risk`, r.risk);
    checkEgressField(`passport.risks[${i}].mitigation`, r.mitigation);
  });
  for (const s of input.scores) checkEgressField(`scores.${s.axis}.explanation`, s.explanation);
  for (const r of input.readiness) {
    r.recommendations.forEach((rec, i) =>
      checkEgressField(`readiness.${r.dimension}.recommendations[${i}]`, rec),
    );
  }
  input.roadmap.forEach((step, i) => {
    checkEgressField(`roadmap[${i}].title`, step.title);
    checkEgressField(`roadmap[${i}].description`, step.description);
  });
}
