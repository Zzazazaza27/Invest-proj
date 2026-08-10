import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';

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

    const result = (await response.json()) as AnalysisResult;
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
