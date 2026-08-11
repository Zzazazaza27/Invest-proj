import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';
import { z } from 'zod';

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
  materials: { type: string; text?: string | null; url?: string | null }[];
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
  passport: z.record(z.string(), z.unknown()),
  facts: z
    .array(
      z.object({
        category: z.string().max(120),
        key: z.string().max(200),
        value: z.record(z.string(), z.unknown()),
        confidence: z.number().min(0).max(1),
        sourceType: z.string().max(60),
        sourceRef: z.string().max(500),
      }),
    )
    .max(500),
  scores: z
    .array(
      z.object({
        axis: z.string().max(60),
        value: z.number().min(0).max(100),
        confidenceLow: z.number().min(0).max(100),
        confidenceHigh: z.number().min(0).max(100),
        explanation: z.string().max(4000),
        sources: z.array(z.string().max(500)).max(50),
      }),
    )
    .max(50),
  irs: z.object({ value: z.number().min(0).max(100) }),
  readiness: z
    .array(
      z.object({
        dimension: z.string().max(60),
        level: z.string().max(20),
        recommendations: z.array(z.string().max(2000)).max(50),
      }),
    )
    .max(50),
  roadmap: z
    .array(
      z.object({
        title: z.string().max(300),
        description: z.string().max(4000),
        dimension: z.string().max(60),
        priority: z.number().int(),
        orderIndex: z.number().int(),
      }),
    )
    .max(200),
  injectionMarkers: z.number().int().nonnegative(),
  durationMs: z.number().nonnegative(),
});

export interface AnalysisResult {
  provider: string;
  isLlm: boolean;
  jurisdiction: string;
  dataClass: string;
  modelVersion: string;
  passport: Record<string, unknown>;
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
  injectionMarkers: number;
  durationMs: number;
}

/** Предел ответа шлюза. Больше — это не анализ проекта, а попытка нагрузить. */
const MAX_RESPONSE_CHARS = 2_000_000;

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

    // Размер ответа ограничен до разбора: `response.json()` на потоке в
    // гигабайт съест память раньше, чем схема успеет что-либо проверить.
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARS) {
      this.logger.error({ msg: 'ответ AI-шлюза превысил предел', traceId, size: raw.length });
      throw errors.upstreamUnavailable('ai_gateway');
    }

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
