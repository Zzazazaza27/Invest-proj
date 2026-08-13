import { describe, expect, it } from 'vitest';
import { ScoreAxisSchema } from '@unicorn/contracts';
import { AnalysisResultSchema, AiGatewayClient } from '../src/ai/ai-gateway.client';

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
    passport: { summary: 'ok' },
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
    readiness: [{ dimension: 'problem', level: 'medium', recommendations: ['шаг'] }],
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
