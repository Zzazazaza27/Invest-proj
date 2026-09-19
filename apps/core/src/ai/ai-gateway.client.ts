import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';
import { z } from 'zod';
import {
  FactCategorySchema,
  FactSourceTypeSchema,
  PassportSchema,
  ReadinessDimensionSchema,
  ReadinessLevelSchema,
  ScoreAxisSchema,
  ScoreSourceTokenSchema,
  type AnalysisMetadata,
  type Passport,
} from '@unicorn/contracts';

/**
 * Клиент AI-шлюза.
 *
 * Шлюз — единственный выход к моделям (ADR-007), поэтому здесь сосредоточены
 * все правила исходящего вызова:
 *
 *  * **Адрес только из конфигурации.** Ни одна часть URL не берётся из
 *    пользовательского ввода — иначе это SSRF, а не интеграция.
 *  * **Таймаут обязателен.** Вызов без ограничения времени держит соединение и
 *    воркер до бесконечности (`RULES.md` §3.1).
 *  * **Ретраев нет.** Анализ не идемпотентен: повтор создал бы вторую версию
 *    паспорта на те же данные. Ошибка возвращается наверх, прогон помечается
 *    неуспешным, решение о повторе принимает человек.
 *  * **Наружу — generic-ошибка.** Тело ответа шлюза в текст ошибки не
 *    попадает: в нём может оказаться содержимое заявки.
 */

export type DataClass = 'public' | 'pseudonymous' | 'pdn' | 'commercial_secret';

export interface AnalysisInput {
  title: string;
  summary: string | null;
  stage: string;
  /**
   * Ответы ПОДАННОЙ версии заявки с формулировками вопросов.
   *
   * Уходят в наш шлюз. Внешней модели они достаются только при согласованных
   * условиях обработки — за этим следит вызывающий, а не клиент.
   */
  answers: { key: string; question: string; text: string }[];
  materials: { type: string; text?: string | null; url?: string | null }[];
  /**
   * Одноразовый nonce прогона (128 бит, hex). Маркеры слота данных
   * опубликованы вместе с промптом; nonce — нет, и только он закрывает слот.
   */
  nonce: string;
  /**
   * Доверенные метаданные платформы для шаблона сообщения (раздел 4 промпта).
   *
   * Тип совпадает с тем, что собирает `buildAnalysisInput`: два описания
   * одного набора полей однажды разошлись бы, и разошлись бы молча.
   */
  metadata: AnalysisMetadata;
}

/**
 * Ключ провайдера на ОДИН вызов (ADR-008 §2). Ядро достаёт его из хранилища
 * и кладёт в тело запроса; шлюз использует и не хранит. В логи не попадает.
 */
export interface ProviderCredential {
  provider: string;
  apiKey: string;
  model: string | null;
}

/**
 * Схема ответа шлюза.
 *
 * Ответ ВНЕШНЕЙ системы разбирается, а не приводится к типу: приведение — это
 * обещание компилятора, а не проверка данных. Скомпрометированный или просто
 * сломанный шлюз возвращал бы что угодно, и это «что угодно» сохранялось в БД
 * и публиковалось как инвестиционный паспорт (CODE-08).
 *
 * Ограничения на длины и количества здесь не косметика: без них ответ на
 * сотни мегабайт проходит разбор и укладывается в таблицу.
 */
export const AnalysisResultSchema = z.object({
  provider: z.string().max(120),
  isLlm: z.boolean(),
  jurisdiction: z.string().max(40),
  dataClass: z.string().max(40),
  modelVersion: z.string().max(120),
  // Строгая схема паспорта (ADR-008, Э1): закрытые перечисления, лимиты длин,
  // отказ на неизвестном ключе. Раньше это было единственное поле без проверки.
  passport: PassportSchema,
  // Пустые facts/scores/readiness раньше проходили разбор: «анализ без единой
  // оценки» сохранялся и публиковался как паспорт. Публичный контракт
  // (`ScoreSchema`) требует непустые sources и enum осей — boundary-схема
  // обязана быть НЕ слабее контракта, иначе single source of truth ломается
  // ровно на границе доверия (CODE-HIGH-06).
  facts: z
    .array(
      z.object({
        // Ровно список CHECK в scoring.passport_facts: иное значение роняло
        // запись уже на вставке — внутренней ошибкой вместо отказа на границе.
        category: FactCategorySchema,
        key: z.string().max(200),
        value: z.record(z.string(), z.unknown()),
        confidence: z.number().min(0).max(1),
        sourceType: FactSourceTypeSchema,
        sourceRef: z.string().max(500),
      }),
    )
    .min(1)
    .max(500),
  scores: z
    .array(
      z
        .object({
          // Оси — enum из контрактов, а не свободная строка: БД и публичный
          // контракт принимают ровно этот список.
          axis: ScoreAxisSchema,
          value: z.number().min(0).max(100),
          confidenceLow: z.number().min(0).max(100),
          confidenceHigh: z.number().min(0).max(100),
          explanation: z.string().max(4000),
          // Оценка без источников — мнение модели, выданное за факт.
          // Закрытый список токенов: каждая строка ложится в
          // `scoring.scores.sources[].type`, и свободный текст там становится
          // «типом источника». 1–4 без повторов — по промпту.
          sources: z
            .array(ScoreSourceTokenSchema)
            .min(1)
            .max(4)
            .refine((items) => new Set(items).size === items.length, {
              message: 'токены источников не должны повторяться',
            }),
        })
        // Интервал уверенности обязан накрывать значение: low ≤ value ≤ high.
        // Оценка 90 с интервалом [10, 20] — внутренне противоречива.
        .refine((s) => s.confidenceLow <= s.value && s.value <= s.confidenceHigh, {
          message: 'confidenceLow <= value <= confidenceHigh нарушено',
        }),
    )
    .min(1)
    .max(50)
    // Полный набор осей без дублей: дубль оси означал бы две оценки одного
    // измерения, а пропуск — паспорт с дырой, которую UI покажет как ноль.
    .refine(
      (scores) => {
        const axes = scores.map((s) => s.axis);
        return new Set(axes).size === axes.length && axes.length === ScoreAxisSchema.options.length;
      },
      { message: 'оси оценок обязаны покрывать полный набор без дублей' },
    ),
  irs: z.object({ value: z.number().min(0).max(100) }),
  readiness: z
    .array(
      z.object({
        // Не «строка до 60 символов», а РОВНО те значения, которые примет БД.
        // Свободная строка проходила проверку и падала уже на вставке
        // ограничением `CHECK`: ответ модели с `level: "critical"` превращался
        // во внутреннюю ошибку вместо честного отказа на границе (CODE-13).
        // Перечисление берётся из контрактов, а не переписывается здесь: две
        // копии одного списка разойдутся.
        dimension: ReadinessDimensionSchema,
        level: ReadinessLevelSchema,
        recommendations: z.array(z.string().max(2000)).max(50),
      }),
    )
    // Ровно тринадцать: схема, требовавшая лишь уникальности, пропускала
    // дырявую карту готовности молча. Полнота проверяется ещё и отдельным
    // ассертом в правилах (assertReadinessComplete) — на случай смены списка.
    .min(13)
    .max(13)
    .refine((entries) => new Set(entries.map((e) => e.dimension)).size === entries.length, {
      message: 'измерения карты готовности не должны дублироваться',
    }),
  roadmap: z
    .array(
      z.object({
        title: z.string().max(300),
        description: z.string().max(4000),
        // В `scoring.roadmap_steps` измерение необязательно, но если оно
        // задано — оно из того же списка.
        dimension: ReadinessDimensionSchema.nullable().optional(),
        priority: z.number().int(),
        orderIndex: z.number().int(),
      }),
    )
    .max(200),
  // Версия промпта — только у LLM-провайдера. Без неё нельзя сказать, какой
  // рубрикой посчитан паспорт (ADR-008 §1).
  promptVersion: z.string().max(60).optional(),
  injectionMarkers: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

export interface AnalysisResult {
  provider: string;
  isLlm: boolean;
  jurisdiction: string;
  dataClass: string;
  modelVersion: string;
  passport: Passport;
  facts: {
    category: string;
    key: string;
    value: Record<string, unknown>;
    confidence: number;
    sourceType: string;
    sourceRef: string;
  }[];
  scores: {
    axis: string;
    value: number;
    confidenceLow: number;
    confidenceHigh: number;
    explanation: string;
    sources: string[];
  }[];
  irs: { value: number };
  readiness: { dimension: string; level: string; recommendations: string[] }[];
  roadmap: {
    title: string;
    description: string;
    dimension: string;
    priority: number;
    orderIndex: number;
  }[];
  promptVersion?: string;
  injectionMarkers: number;
  durationMs: number;
}

/**
 * Предел ответа шлюза В БАЙТАХ. Больше — это не анализ проекта, а попытка
 * нагрузить. Предел применяется ПОТОКОВО, по мере чтения чанков: прежний код
 * сначала буферизовал ответ целиком (`response.text()`), потом сравнивал длину —
 * chunked-ответ в гигабайты исчерпал бы память ядра раньше проверки
 * (CODE-HIGH-08 / SEC-HIGH-08).
 */
const MAX_RESPONSE_BYTES = 2_000_000;

@Injectable()
export class AiGatewayClient {
  private readonly logger = new Logger(AiGatewayClient.name);

  get isConfigured(): boolean {
    const env = getEnv();
    return Boolean(env.AI_GATEWAY_URL && env.AI_GATEWAY_TOKEN);
  }

  async analyze(
    input: AnalysisInput,
    dataClass: DataClass,
    traceId: string,
    options: { credential?: ProviderCredential | null } = {},
  ): Promise<AnalysisResult> {
    const env = getEnv();
    if (!this.isConfigured) throw errors.featureDisabled('ai_gateway');

    // URL собирается из базового адреса конфигурации; путь — константа.
    const url = new URL('/v1/analyze', env.AI_GATEWAY_URL);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          task: 'project_analysis',
          data_class: dataClass,
          project: input,
          trace_id: traceId,
          // Провайдер и его ключ — только когда оператор задал ключ и включил
          // LLM-скоринг; иначе шлюз берёт провайдера по умолчанию (эвристику).
          ...(options.credential
            ? {
                provider: options.credential.provider,
                provider_credential: {
                  api_key: options.credential.apiKey,
                  model: options.credential.model,
                },
              }
            : {}),
        }),
        signal: AbortSignal.timeout(env.AI_GATEWAY_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error({
        msg: 'AI-шлюз недоступен',
        traceId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw errors.upstreamUnavailable('ai_gateway');
    }

    if (response.status === 403) {
      // Резидентность. Это не сбой связи и повторять запрос нельзя.
      this.logger.error({ msg: 'шлюз отклонил запрос по юрисдикции', traceId });
      throw errors.residencyViolation();
    }
    if (!response.ok) {
      this.logger.error({ msg: 'AI-шлюз вернул ошибку', traceId, status: response.status });
      throw errors.upstreamUnavailable('ai_gateway');
    }

    const raw = await this.readBounded(response, traceId);

    const parsed = AnalysisResultSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Несоответствие схеме — отказ, а не «сохраним что дали»: результат
      // анализа публикуется и становится инвестиционным паспортом.
      this.logger.error({
        msg: 'ответ AI-шлюза не соответствует схеме',
        traceId,
        issues: parsed.error.issues.slice(0, 3).map((issue) => issue.path.join('.')),
      });
      throw errors.upstreamUnavailable('ai_gateway');
    }
    const result = parsed.data as AnalysisResult;
    return this.handleParsed(result, traceId);
  }

  /**
   * Чтение тела с потоковым пределом. `Content-Length` — ранний сигнал, но не
   * доказательство: chunked-ответ его не имеет, поэтому счётчик байтов ведётся
   * по фактическим чанкам, а превышение обрывает поток немедленно.
   */
  /**
   * Проверка ключа провайдера коротким вызовом без текста заявки (панель).
   * Ответ шлюза — да/нет, код причины и имя модели; ключ наружу не выходит.
   */
  /**
   * Каталог моделей провайдера по ключу — для выбора модели в панели.
   * Ключ уходит на один вызов и нигде не сохраняется; в ответе — только
   * идентификаторы моделей, отфильтрованные шлюзом.
   */
  async listProviderModels(
    input: { provider: string; apiKey: string },
    traceId: string,
  ): Promise<{
    ok: boolean;
    source: 'provider' | 'static';
    models: string[];
    code?: string;
    upstreamStatus?: number | null;
    durationMs: number;
  }> {
    const env = getEnv();
    if (!this.isConfigured) throw errors.featureDisabled('ai_gateway');
    const url = new URL('/v1/providers/models', env.AI_GATEWAY_URL);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          provider: input.provider,
          provider_credential: { api_key: input.apiKey },
        }),
        signal: AbortSignal.timeout(env.AI_GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw errors.upstreamUnavailable('ai_gateway');
    }
    if (!response.ok) {
      this.logger.warn({
        msg: 'шлюз отклонил запрос каталога моделей',
        status: response.status,
        traceId,
      });
      throw errors.upstreamUnavailable('ai_gateway');
    }
    const parsed = z
      .object({
        ok: z.boolean(),
        source: z.enum(['provider', 'static']),
        models: z.array(z.string().max(120)).max(200),
        code: z.string().max(60).optional(),
        upstreamStatus: z.number().int().nullable().optional(),
        durationMs: z.number().nonnegative(),
      })
      .safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      this.logger.warn({ msg: 'шлюз вернул каталог моделей вне контракта', traceId });
      throw errors.upstreamUnavailable('ai_gateway');
    }
    return parsed.data;
  }

  async checkProvider(
    credential: ProviderCredential,
    traceId: string,
  ): Promise<{
    ok: boolean;
    code?: string;
    model?: string | null;
    upstreamStatus?: number | null;
    durationMs: number;
  }> {
    const env = getEnv();
    if (!this.isConfigured) throw errors.featureDisabled('ai_gateway');
    const url = new URL('/v1/providers/check', env.AI_GATEWAY_URL);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          provider: credential.provider,
          provider_credential: { api_key: credential.apiKey, model: credential.model },
        }),
        signal: AbortSignal.timeout(env.AI_GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw errors.upstreamUnavailable('ai_gateway');
    }
    if (!response.ok) {
      this.logger.warn({ msg: 'шлюз отклонил проверку ключа', status: response.status, traceId });
      throw errors.upstreamUnavailable('ai_gateway');
    }
    const parsed = z
      .object({
        ok: z.boolean(),
        code: z.string().max(60).optional(),
        model: z.string().max(120).nullable().optional(),
        upstreamStatus: z.number().int().nullable().optional(),
        durationMs: z.number().nonnegative(),
      })
      .safeParse(await response.json());
    if (!parsed.success) throw errors.upstreamUnavailable('ai_gateway');
    return parsed.data;
  }

  /**
   * Проход локализации паспорта (ADR-008 §5): переводимые поля — в слоте с
   * nonce, числа — справкой вне слота. Ответ разбирается схемой: форма
   * `translated` обязана совпасть с отправленной, это проверяет вызывающая
   * сторона по ключам.
   */
  async translatePassport(
    input: {
      locale: 'en-US' | 'ru-RU';
      nonce: string;
      numbers: Record<string, unknown>;
      texts: Record<string, unknown>;
    },
    credential: ProviderCredential,
    traceId: string,
  ): Promise<{
    translated: Record<string, unknown>;
    flags: string[];
    modelVersion: string;
    promptVersion: string;
  }> {
    const env = getEnv();
    if (!this.isConfigured) throw errors.featureDisabled('ai_gateway');
    const url = new URL('/v1/translate', env.AI_GATEWAY_URL);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.AI_GATEWAY_TOKEN}`,
        },
        body: JSON.stringify({
          provider: credential.provider,
          provider_credential: { api_key: credential.apiKey, model: credential.model },
          locale: input.locale,
          nonce: input.nonce,
          numbers: input.numbers,
          texts: input.texts,
        }),
        signal: AbortSignal.timeout(env.AI_GATEWAY_TIMEOUT_MS),
      });
    } catch {
      throw errors.upstreamUnavailable('ai_gateway');
    }
    if (!response.ok) {
      this.logger.warn({ msg: 'шлюз отклонил перевод паспорта', status: response.status, traceId });
      throw errors.upstreamUnavailable('ai_gateway');
    }
    const raw = await this.readBounded(response, traceId);
    const parsed = z
      .object({
        translated: z.record(z.string(), z.unknown()),
        flags: z.array(z.string().max(60)).max(10),
        modelVersion: z.string().max(120),
        promptVersion: z.string().max(60),
      })
      .safeParse(JSON.parse(raw));
    if (!parsed.success) throw errors.upstreamUnavailable('ai_gateway');
    return parsed.data;
  }

  private async readBounded(response: Response, traceId: string): Promise<string> {
    const declared = Number(response.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      this.logger.error({ msg: 'ответ AI-шлюза превысил предел', traceId, size: declared });
      await response.body?.cancel().catch(() => undefined);
      throw errors.upstreamUnavailable('ai_gateway');
    }
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        this.logger.error({ msg: 'ответ AI-шлюза превысил предел', traceId });
        throw errors.upstreamUnavailable('ai_gateway');
      }
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        this.logger.error({ msg: 'ответ AI-шлюза превысил предел', traceId, size: received });
        throw errors.upstreamUnavailable('ai_gateway');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private handleParsed(result: AnalysisResult, traceId: string): AnalysisResult {
    if (result.injectionMarkers > 0) {
      // Поведение шлюза от этого не изменилось — запись нужна, чтобы попытка
      // была видна в журнале приложения, а не только в журнале шлюза.
      this.logger.warn({
        msg: 'в материалах проекта найдены признаки prompt-injection',
        traceId,
        markers: result.injectionMarkers,
      });
    }
    return result;
  }
}
