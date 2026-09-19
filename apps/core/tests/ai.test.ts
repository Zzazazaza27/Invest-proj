import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReadinessDimensionSchema, ScoreAxisSchema } from '@unicorn/contracts';
import { AnalysisResultSchema, AiGatewayClient } from '../src/ai/ai-gateway.client';
import { PROMPT_VERSION, llmModelVersion } from '../src/ai/provider-credentials.service';

/**
 * Boundary-схема ответа AI-шлюза (Ф33, CODE-HIGH-06).
 *
 * Схема на границе доверия обязана быть НЕ слабее публичного контракта:
 * пустые оценки, свободные оси, дубли и внутренне противоречивые интервалы
 * раньше проходили разбор и публиковались как инвестиционный паспорт.
 * Каждый негативный тест здесь — конкретный вариант отравленного ответа.
 */

function validScore(axis: string) {
  return {
    axis,
    value: 50,
    confidenceLow: 40,
    confidenceHigh: 60,
    explanation: 'объяснение',
    sources: ['application_text'],
  };
}

function validResult(): Record<string, unknown> {
  return {
    provider: 'internal',
    isLlm: false,
    jurisdiction: 'ru',
    dataClass: 'pseudonymous',
    modelVersion: 'v0.1-heuristic',
    // Паспорт — в строгой форме Э1: одна схема на эвристику и LLM.
    passport: {
      score10: 6,
      irsBreakdown: Object.fromEntries([
        ['sum', 50],
        ...ScoreAxisSchema.options.map((axis) => [axis, 50]),
        ...ScoreAxisSchema.options.map((axis) => [`${axis}_w`, 5]),
      ]),
      scoreBasis: 'disclosure',
      verdict: 'ok',
      strengths: [],
      weaknesses: [],
      risks: [],
      capsApplied: [],
      penaltiesApplied: [],
      integrityFlags: [],
      complianceFlags: [],
      businessModel: 'not_stated',
      askSanity: 'not_stated',
      investorExit: 'not_stated',
      evidenceLevel: 'absent',
    },
    facts: [
      {
        category: 'market',
        key: 'market_signal_count',
        value: { count: 1 },
        confidence: 0.9,
        sourceType: 'application_text',
        sourceRef: 'title+summary',
      },
    ],
    scores: ScoreAxisSchema.options.map((axis) => validScore(axis)),
    irs: { value: 50 },
    // Ровно тринадцать: дырявая карта готовности больше не проходит разбор.
    readiness: ReadinessDimensionSchema.options.map((dimension) => ({
      dimension,
      level: 'medium',
      recommendations: ['шаг'],
    })),
    roadmap: [],
    injectionMarkers: 0,
    durationMs: 10,
  };
}

describe('AnalysisResultSchema (boundary-схема шлюза)', () => {
  it('полный корректный ответ проходит', () => {
    expect(AnalysisResultSchema.safeParse(validResult()).success).toBe(true);
  });

  it('пустой список оценок отвергается', () => {
    const bad = { ...validResult(), scores: [] };
    expect(AnalysisResultSchema.safeParse(bad).success).toBe(false);
  });

  it('пустой список фактов отвергается', () => {
    const bad = { ...validResult(), facts: [] };
    expect(AnalysisResultSchema.safeParse(bad).success).toBe(false);
  });

  it('пустая карта готовности отвергается', () => {
    const bad = { ...validResult(), readiness: [] };
    expect(AnalysisResultSchema.safeParse(bad).success).toBe(false);
  });

  it('свободная строка вместо оси отвергается', () => {
    const scores = ScoreAxisSchema.options.map((axis) => validScore(axis));
    scores[0] = validScore('vibes');
    expect(AnalysisResultSchema.safeParse({ ...validResult(), scores }).success).toBe(false);
  });

  it('дубль оси отвергается', () => {
    const scores = ScoreAxisSchema.options.map((axis) => validScore(axis));
    scores[1] = validScore(ScoreAxisSchema.options[0]!);
    expect(AnalysisResultSchema.safeParse({ ...validResult(), scores }).success).toBe(false);
  });

  it('неполный набор осей отвергается', () => {
    const scores = ScoreAxisSchema.options.slice(0, -1).map((axis) => validScore(axis));
    expect(AnalysisResultSchema.safeParse({ ...validResult(), scores }).success).toBe(false);
  });

  it('оценка вне интервала уверенности отвергается', () => {
    const scores = ScoreAxisSchema.options.map((axis) => validScore(axis));
    scores[0] = { ...scores[0]!, value: 90, confidenceLow: 10, confidenceHigh: 20 };
    expect(AnalysisResultSchema.safeParse({ ...validResult(), scores }).success).toBe(false);
  });

  it('оценка без источников отвергается', () => {
    const scores = ScoreAxisSchema.options.map((axis) => validScore(axis));
    scores[0] = { ...scores[0]!, sources: [] };
    expect(AnalysisResultSchema.safeParse({ ...validResult(), scores }).success).toBe(false);
  });

  it('дубль измерения готовности отвергается', () => {
    const readiness = [
      { dimension: 'problem', level: 'medium', recommendations: [] },
      { dimension: 'problem', level: 'low', recommendations: [] },
    ];
    expect(AnalysisResultSchema.safeParse({ ...validResult(), readiness }).success).toBe(false);
  });
});

describe('потоковый предел ответа шлюза (CODE-HIGH-08)', () => {
  const client = new AiGatewayClient();
  const readBounded = (response: Response) =>
    (client as unknown as { readBounded(r: Response, t: string): Promise<string> }).readBounded(
      response,
      'test-trace',
    );

  it('небольшой ответ читается целиком', async () => {
    const body = JSON.stringify({ ok: true });
    await expect(readBounded(new Response(body))).resolves.toBe(body);
  });

  it('заявленный Content-Length сверх предела отвергается до чтения тела', async () => {
    const response = new Response('x', {
      headers: { 'content-length': String(100_000_000) },
    });
    await expect(readBounded(response)).rejects.toThrow();
  });

  it('chunked-поток без Content-Length обрывается на пределе, не буферизуясь целиком', async () => {
    // Бесконечный поток: без потокового счётчика этот тест не завершился бы —
    // прежний `response.text()` копил бы чанки до исчерпания памяти.
    const chunk = new Uint8Array(1_000_000);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        // Страховка от вечного цикла, если предел перестанет срабатывать:
        // 10 МБ — заведомо больше предела в 2 МБ.
        if (sent > 10_000_000) controller.close();
      },
    });
    await expect(readBounded(new Response(stream))).rejects.toThrow();
    expect(sent).toBeLessThanOrEqual(4_000_000);
  });
});

/**
 * Версия промпта живёт в двух местах: в ядре (оно собирает строку версии
 * модели и проверяет eval-гейт до обращения к шлюзу) и в самом шлюзе (он
 * выбирает файлы промпта). Дублирование неизбежно, молчаливое расхождение —
 * нет.
 *
 * Расхождение уже случалось: шлюз перешёл на v2.6, ядро осталось на v2.5.2.
 * Последствие не в неудобстве, а в неправде: паспорт получал бы метку
 * рубрики, которой его не считали, — и `--only-stale` считал бы такие
 * паспорта свежими.
 */
describe('Версия промпта ядра и шлюза', () => {
  it('совпадает с PROMPT_VERSION шлюза', () => {
    const llmPy = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ai-gateway', 'app', 'llm.py'),
      'utf8',
    );
    const match = llmPy.match(/PROMPT_VERSION\s*:\s*Final\[str\]\s*=\s*"([^"]+)"/);
    expect(match, 'PROMPT_VERSION не найден в apps/ai-gateway/app/llm.py').not.toBeNull();
    expect(PROMPT_VERSION).toBe(match![1]);
  });

  it('строка версии модели содержит версию промпта', () => {
    // По ней читается, какой рубрикой посчитан паспорт: без версии промпта
    // строка отвечала бы только «каким провайдером».
    expect(llmModelVersion('deepseek', 'deepseek-v4-flash')).toBe(
      `llm:deepseek:deepseek-v4-flash:${PROMPT_VERSION}`,
    );
    expect(llmModelVersion('openai', null)).toBe(`llm:openai:default:${PROMPT_VERSION}`);
  });
});
