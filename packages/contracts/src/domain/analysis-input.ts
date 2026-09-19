import { z } from 'zod';

/**
 * Единый вход разбора заявки (этап 6.1).
 *
 * ОДНО место, где из неизменяемого снимка поданной версии собирается всё, что
 * уходит в разбор: текст ответов с формулировками вопросов, метаданные,
 * идентификатор версии. Раньше вход собирался по дороге в шлюз, и ответить на
 * вопрос «что именно анализировалось» можно было только чтением кода.
 *
 * Три правила, ради которых модуль существует.
 *
 * **1. Не выдумывать полей.** Чего нет в снимке — того нет во входе. Пустое
 * значение остаётся пустым: `null` честнее, чем подставленная догадка.
 *
 * **2. Называть источник каждого поля.** Снимок поданной версии неизменяем, а
 * карточка проекта и раунд меняются. Если значение взято не из снимка, это
 * записано рядом со значением — иначе «отчёт по версии N» тихо включал бы в
 * себя сегодняшнюю правку карточки.
 *
 * **3. Вход целиком попадает в отпечаток.** Отпечаток обязан описывать
 * фактически проанализированные данные, а не намерение их проанализировать.
 */

/** Откуда взято значение. */
export const InputSourceSchema = z.enum(['version', 'card', 'round', 'absent']);
export type InputSource = z.infer<typeof InputSourceSchema>;

export const AnalysisAnswerSchema = z.object({
  key: z.string(),
  /** Формулировка вопроса на языке подачи — из того же снимка. */
  question: z.string(),
  /** Раздел анкеты, к которому относится вопрос. */
  section: z.string(),
  text: z.string(),
});
export type AnalysisAnswer = z.infer<typeof AnalysisAnswerSchema>;

export const AnalysisMetadataSchema = z.object({
  investmentAsk: z.string().nullable(),
  currency: z.string(),
  taxonomy: z.string().nullable(),
  geoCountry: z.string().nullable(),
  /**
   * Страна запуска.
   *
   * Источника нет: такого вопроса в анкете не существует, а страна
   * обслуживания аккаунта — не то же самое. Поле остаётся пустым до появления
   * вопроса; подставлять вместо него страну проекта нельзя.
   */
  launchCountry: z.string().nullable(),
  businessType: z.string().nullable(),
  fundingScope: z.string().nullable(),
  fundingScopeNote: z.string().nullable(),
  /** На что пойдут средства — ответ анкеты, а не отдельное поле. */
  useOfFunds: z.string().nullable(),
  runwayCurrentMonths: z.string().nullable(),
  runwayWithFundsMonths: z.string().nullable(),
});
export type AnalysisMetadata = z.infer<typeof AnalysisMetadataSchema>;

export const AnalysisInputViewSchema = z.object({
  /** Версия, из снимка которой собран вход; null — заявка не подана. */
  versionId: z.uuid().nullable(),
  versionNo: z.number().int().nullable(),
  title: z.string(),
  stage: z.string(),
  /** Текст заявки: ответы с формулировками вопросов, по разделам. */
  summary: z.string(),
  answers: z.array(AnalysisAnswerSchema),
  metadata: AnalysisMetadataSchema,
  /**
   * Источник каждого поля входа. Ключ — имя поля, значение — откуда взято.
   * Поля со значением `card` меняются вместе с карточкой проекта, и отчёт по
   * версии заявки их не замораживает.
   */
  sources: z.record(z.string(), InputSourceSchema),
  /** Ответы участвовали. false — разобрана только карточка проекта. */
  includesAnswers: z.boolean(),
});
export type AnalysisInputView = z.infer<typeof AnalysisInputViewSchema>;

/** Снимок поданной версии — ровно те части, которые нужны разбору. */
export interface SubmittedSnapshot {
  core?: {
    title?: string | null;
    stage?: string | null;
    businessType?: string | null;
    fundingScope?: string | null;
    fundingScopeNote?: string | null;
    investmentAsk?: string | null;
    askCurrency?: string | null;
  } | null;
  project?: {
    title?: string | null;
    tagline?: string | null;
    description?: string | null;
    geoCountry?: string | null;
  } | null;
  answers?: Record<string, unknown> | null;
  applicableKeys?: Record<string, string> | null;
  form?: {
    sections?:
      | {
          title?: string | null;
          questions?: { key?: string | null; title?: string | null }[] | null;
        }[]
      | null;
  } | null;
}

/** Текущая карточка проекта: используется только там, где снимка не хватает. */
export interface ProjectCard {
  title: string;
  tagline: string | null;
  description: string | null;
  stage: string;
  investmentAsk: string | null;
  askCurrency: string | null;
  taxonomy: string | null;
  geoCountry: string | null;
}

/** Ключи анкеты, значения которых попадают в метаданные как есть. */
const USE_OF_FUNDS_KEY = 'use_of_funds';
const RUNWAY_CURRENT_KEY = 'runway_current_months';
const RUNWAY_WITH_FUNDS_KEY = 'runway_with_funds_months';

/**
 * Собрать вход разбора.
 *
 * `snapshot === null` означает, что заявка не подана: тогда вход собирается из
 * карточки проекта, ответов в нём нет, и `includesAnswers` равен false.
 * Называть такой разбор анализом версии заявки нельзя.
 */
export function buildAnalysisInput(input: {
  snapshot: SubmittedSnapshot | null;
  versionId: string | null;
  versionNo: number | null;
  card: ProjectCard;
}): AnalysisInputView {
  const { snapshot, card } = input;
  const sources: Record<string, InputSource> = {};

  /** Взять из снимка, иначе из карточки, и записать источник. */
  function pick(field: string, fromVersion: unknown, fromCard: string | null): string | null {
    const version = normalize(fromVersion);
    if (version !== null) {
      sources[field] = 'version';
      return version;
    }
    if (fromCard !== null && fromCard.trim().length > 0) {
      sources[field] = 'card';
      return fromCard;
    }
    sources[field] = 'absent';
    return null;
  }

  const answers = collectAnswers(snapshot);
  const title = pick('title', snapshot?.core?.title ?? snapshot?.project?.title, card.title) ?? '';
  const stage = pick('stage', snapshot?.core?.stage, card.stage) ?? 'idea';

  const metadata: AnalysisMetadata = {
    investmentAsk: pick('investmentAsk', snapshot?.core?.investmentAsk, card.investmentAsk),
    currency: pick('currency', snapshot?.core?.askCurrency, card.askCurrency) ?? 'RUB',
    // Отрасли в снимке нет: там лежит только идентификатор таксономии, а имя
    // берётся из справочника, который живёт отдельно и может меняться.
    taxonomy: pick('taxonomy', null, card.taxonomy),
    geoCountry: pick('geoCountry', snapshot?.project?.geoCountry, card.geoCountry),
    launchCountry: markAbsent(sources, 'launchCountry'),
    businessType: pick('businessType', snapshot?.core?.businessType, null),
    fundingScope: pick('fundingScope', snapshot?.core?.fundingScope, null),
    fundingScopeNote: pick('fundingScopeNote', snapshot?.core?.fundingScopeNote, null),
    useOfFunds: pick('useOfFunds', answerByKey(answers, USE_OF_FUNDS_KEY), null),
    runwayCurrentMonths: pick(
      'runwayCurrentMonths',
      answerByKey(answers, RUNWAY_CURRENT_KEY),
      null,
    ),
    runwayWithFundsMonths: pick(
      'runwayWithFundsMonths',
      answerByKey(answers, RUNWAY_WITH_FUNDS_KEY),
      null,
    ),
  };

  const summary =
    answers.length > 0
      ? renderApplicationText(answers)
      : // Заявка не подана: в текст идёт то немногое, что есть в карточке, и
        // источник этого прямо назван.
        [card.tagline, card.description].filter(Boolean).join('\n');
  sources.summary = answers.length > 0 ? 'version' : 'card';

  return {
    versionId: answers.length > 0 ? input.versionId : null,
    versionNo: answers.length > 0 ? input.versionNo : null,
    title,
    stage,
    summary,
    answers,
    metadata,
    sources,
    includesAnswers: answers.length > 0,
  };
}

/**
 * Текст заявки для разбора.
 *
 * Ответ без вопроса бессмыслен: «5 лет» может относиться к возрасту команды,
 * сроку окупаемости или длительности контракта. Поэтому текст собирается
 * парами «вопрос — ответ» и разбит по разделам анкеты.
 */
export function renderApplicationText(answers: AnalysisAnswer[]): string {
  const bySection = new Map<string, AnalysisAnswer[]>();
  for (const answer of answers) {
    const list = bySection.get(answer.section) ?? [];
    list.push(answer);
    bySection.set(answer.section, list);
  }

  const parts: string[] = [];
  for (const [section, list] of bySection) {
    if (section.length > 0) parts.push(`## ${section}`);
    for (const answer of list) {
      parts.push(`${answer.question}\n${answer.text}`);
    }
  }
  return parts.join('\n\n');
}

/** Ответы показанных вопросов с формулировками и разделами. */
function collectAnswers(snapshot: SubmittedSnapshot | null): AnalysisAnswer[] {
  if (!snapshot) return [];
  const answers = snapshot.answers ?? {};
  const applicable = snapshot.applicableKeys ?? {};
  const meta = questionMeta(snapshot);

  const out: AnalysisAnswer[] = [];
  for (const key of Object.keys(applicable)) {
    const text = normalize(answers[key]);
    if (text === null) continue;
    out.push({
      key,
      question: meta[key]?.question ?? key,
      section: meta[key]?.section ?? '',
      text,
    });
  }
  return out;
}

/** Формулировка и раздел по ключу вопроса — из снимка формы. */
function questionMeta(
  snapshot: SubmittedSnapshot,
): Record<string, { question: string; section: string }> {
  const out: Record<string, { question: string; section: string }> = {};
  for (const section of snapshot.form?.sections ?? []) {
    for (const question of section?.questions ?? []) {
      if (typeof question?.key === 'string') {
        out[question.key] = {
          question: typeof question.title === 'string' ? question.title : question.key,
          section: typeof section?.title === 'string' ? section.title : '',
        };
      }
    }
  }
  return out;
}

function answerByKey(answers: AnalysisAnswer[], key: string): string | null {
  return answers.find((answer) => answer.key === key)?.text ?? null;
}

/** Поле, которому неоткуда взяться. Записывается явно, а не молчанием. */
function markAbsent(sources: Record<string, InputSource>, field: string): null {
  sources[field] = 'absent';
  return null;
}

/**
 * Значение в текст.
 *
 * Анкета хранит строки, числа, списки и объекты со свободным комментарием.
 * Разбору нужен текст — но выдумывать его нельзя: пустое остаётся пустым.
 */
function normalize(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => normalize(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join('; ') : null;
  }
  if (typeof value === 'object') {
    const parts = Object.values(value as Record<string, unknown>)
      .map((item) => normalize(item))
      .filter((item): item is string => item !== null);
    return parts.length > 0 ? parts.join(' ') : null;
  }
  return null;
}
