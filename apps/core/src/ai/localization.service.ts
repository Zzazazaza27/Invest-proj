import { Injectable, Logger } from '@nestjs/common';
import { uuidv7, type StoredPassport } from '@unicorn/contracts';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { AiGatewayClient, type ProviderCredential } from './ai-gateway.client';
import { checkEgressField, newNonce } from './scoring-rules';

/**
 * Язык показа — отдельная ось от языка оценки (ADR-008 §5, промпт раздел 11).
 *
 * Оценка считается ОДИН раз на версию заявки, на `ru-RU`. Сразу после неё —
 * проход перевода: английский нарратив ложится в `scoring.passport_texts`
 * отдельной строкой на версию паспорта. На чтении ничего не генерируется —
 * никогда: инвестор №57 с английским кабинетом читает готовую строку.
 *
 * Почему не «прогнать оценку второй раз по-английски»: другая лексика даёт
 * другие срабатывания рубрики, и инвестор, переключивший язык, увидел бы
 * другое число рядом с тем же проектом. Поэтому переводится только текст, а
 * числа — источник правды в `scores` и `irs_scores` — не трогаются.
 *
 * Перевод — свой прогон в `audit.agent_runs`: упавший перевод не делает
 * оценку неуспешной, паспорт остаётся читаемым на канонической локали.
 */

export const TARGET_LOCALE = 'en-US' as const;

/** Переводимые поля паспорта (таблица 11.3). Всё остальное — языконезависимо. */
export interface TranslatableTexts {
  verdict: string;
  strengths: string[];
  weaknesses: string[];
  risks: { risk: string; mitigation: string }[];
  businessModel: string;
  askSanity: string;
  investorExit: string;
  explanations: Record<string, string>;
  recommendations: Record<string, string[]>;
  roadmap: { title: string; description: string | null }[];
}

@Injectable()
export class LocalizationService {
  private readonly logger = new Logger(LocalizationService.name);

  constructor(
    private readonly db: Database,
    private readonly gateway: AiGatewayClient,
  ) {}

  /**
   * Перевод действующего паспорта. Не бросает: результат — записана строка или
   * прогон помечен неуспешным. Вызывается сразу после публикации оценки.
   */
  async translate(
    ctx: RequestContext,
    projectId: string,
    passportId: string,
    credential: ProviderCredential,
  ): Promise<void> {
    const runId = uuidv7();
    try {
      const source = await this.db.readOnly(ctx, (tx) => this.collect(tx, projectId, passportId));
      if (!source) return;
      await this.db.transaction(ctx, async (tx) => {
        await tx.query(
          `INSERT INTO audit.agent_runs (id, graph_name, project_id, user_id, status)
           VALUES ($1, 'passport_translation', $2, $3, 'running')`,
          [runId, projectId, ctx.userId],
        );
      });

      const nonce = newNonce();
      const result = await this.gateway.translatePassport(
        {
          locale: TARGET_LOCALE,
          nonce,
          numbers: source.numbers,
          texts: source.texts as unknown as Record<string, unknown>,
        },
        credential,
        ctx.traceId,
      );

      const translated = this.validate(source.texts, result.translated);

      await this.db.transaction(ctx, async (tx) => {
        const model = await tx.query<{ id: string }>(
          `SELECT id FROM scoring.score_models WHERE name = 'ai_score' AND is_active`,
        );
        await tx.query(
          `INSERT INTO scoring.passport_texts (passport_id, locale, payload_jsonb, model_id)
           VALUES ($1, $2, $3::jsonb, $4)
           ON CONFLICT (passport_id, locale) DO UPDATE
             SET payload_jsonb = EXCLUDED.payload_jsonb, model_id = EXCLUDED.model_id,
                 created_at = now()`,
          [passportId, TARGET_LOCALE, JSON.stringify(translated), model.rows[0]?.id ?? null],
        );
        await tx.query(
          `INSERT INTO audit.node_checkpoints (id, run_id, node_name, state_jsonb)
           VALUES ($1, $2, 'translation', $3::jsonb)`,
          [
            uuidv7(),
            runId,
            JSON.stringify({
              locale: TARGET_LOCALE,
              modelVersion: result.modelVersion,
              promptVersion: result.promptVersion,
              flags: result.flags,
              nonce,
            }),
          ],
        );
        await tx.query(
          `UPDATE audit.agent_runs SET status = 'succeeded', finished_at = now() WHERE id = $1`,
          [runId],
        );
      });
    } catch (error) {
      // Упавший перевод — не упавшая оценка. След остаётся: прогон помечается,
      // причина — в журнале ядра без содержимого.
      this.logger.warn({
        msg: 'перевод паспорта не выполнен',
        projectId,
        passportId,
        traceId: ctx.traceId,
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await this.db
        .transaction(ctx, async (tx) => {
          await tx.query(
            `UPDATE audit.agent_runs SET status = 'failed', finished_at = now()
              WHERE id = $1 AND status = 'running'`,
            [runId],
          );
        })
        .catch(() => undefined);
    }
  }

  /** Готовый перевод для подстановки при чтении. `null` — перевода ещё нет. */
  async textsFor(tx: Tx, passportId: string, locale: string): Promise<TranslatableTexts | null> {
    if (locale !== TARGET_LOCALE) return null;
    const { rows } = await tx.query<{ payload_jsonb: TranslatableTexts }>(
      `SELECT payload_jsonb FROM scoring.passport_texts WHERE passport_id = $1 AND locale = $2`,
      [passportId, locale],
    );
    return rows[0]?.payload_jsonb ?? null;
  }

  private async collect(
    tx: Tx,
    projectId: string,
    passportId: string,
  ): Promise<{ numbers: Record<string, unknown>; texts: TranslatableTexts } | null> {
    const passport = await tx.query<{ jsonb_data: StoredPassport }>(
      `SELECT jsonb_data FROM scoring.investment_passports WHERE id = $1`,
      [passportId],
    );
    const data = passport.rows[0]?.jsonb_data;
    if (!data) return null;
    const scores = await tx.query<{ axis: string; value: string; explanation: string }>(
      `SELECT axis, value::text AS value, explanation FROM scoring.scores WHERE passport_id = $1 ORDER BY axis`,
      [passportId],
    );
    const readiness = await tx.query<{ dimension: string; recommendations: string[] }>(
      `SELECT dimension, recommendations FROM scoring.readiness_map WHERE project_id = $1 ORDER BY dimension`,
      [projectId],
    );
    const roadmap = await tx.query<{ title: string; description: string | null }>(
      `SELECT s.title, s.description
         FROM scoring.roadmap_steps s
         JOIN scoring.roadmaps r ON r.id = s.roadmap_id
        WHERE r.project_id = $1 AND r.is_active AND r.generated_by = 'ai'
        ORDER BY s.order_index`,
      [projectId],
    );
    return {
      numbers: {
        irs: data.irsComputed,
        score10: data.score10Published,
        scores: Object.fromEntries(scores.rows.map((s) => [s.axis, Number(s.value)])),
      },
      texts: {
        verdict: data.verdict,
        strengths: data.strengths,
        weaknesses: data.weaknesses,
        risks: data.risks,
        businessModel: data.businessModel,
        askSanity: data.askSanity,
        investorExit: data.investorExit,
        explanations: Object.fromEntries(scores.rows.map((s) => [s.axis, s.explanation])),
        recommendations: Object.fromEntries(
          readiness.rows.map((r) => [r.dimension, r.recommendations]),
        ),
        roadmap: roadmap.rows,
      },
    };
  }

  /**
   * Перевод принимается только в той же форме: те же ключи, те же длины
   * массивов, строки — через egress-фильтр. Всё, что модель добавила или
   * потеряла, — отказ: сохранять «почти тот же» перевод нельзя, потому что
   * читатель не увидит, чего в нём нет.
   */
  private validate(source: TranslatableTexts, raw: Record<string, unknown>): TranslatableTexts {
    const str = (field: string, value: unknown, max: number): string => {
      if (typeof value !== 'string' || value.length > max) {
        throw new Error(`перевод: поле ${field} не строка или длиннее ${max}`);
      }
      return checkEgressField(field, value);
    };
    const list = (field: string, value: unknown, expected: number, max: number): string[] => {
      if (!Array.isArray(value) || value.length !== expected) {
        throw new Error(`перевод: ${field} — ожидалось ${expected} элементов`);
      }
      return value.map((v, i) => str(`${field}[${i}]`, v, max));
    };
    const signal = (field: string, value: unknown, original: string): string =>
      original === 'not_stated' ? 'not_stated' : str(field, value, 400);

    const risksRaw = Array.isArray(raw.risks) ? (raw.risks as unknown[]) : [];
    if (risksRaw.length !== source.risks.length) throw new Error('перевод: risks — иная длина');
    const explanationsRaw = (raw.explanations ?? {}) as Record<string, unknown>;
    const recommendationsRaw = (raw.recommendations ?? {}) as Record<string, unknown>;
    const roadmapRaw = Array.isArray(raw.roadmap) ? (raw.roadmap as unknown[]) : [];
    if (roadmapRaw.length !== source.roadmap.length)
      throw new Error('перевод: roadmap — иная длина');

    return {
      verdict: str('verdict', raw.verdict, 800),
      strengths: list('strengths', raw.strengths, source.strengths.length, 260),
      weaknesses: list('weaknesses', raw.weaknesses, source.weaknesses.length, 260),
      risks: risksRaw.map((r, i) => {
        const item = (r ?? {}) as Record<string, unknown>;
        return {
          risk: str(`risks[${i}].risk`, item.risk, 400),
          mitigation: str(`risks[${i}].mitigation`, item.mitigation, 400),
        };
      }),
      businessModel: signal('businessModel', raw.businessModel, source.businessModel),
      askSanity: signal('askSanity', raw.askSanity, source.askSanity),
      investorExit: signal('investorExit', raw.investorExit, source.investorExit),
      explanations: Object.fromEntries(
        Object.keys(source.explanations).map((axis) => [
          axis,
          str(`explanations.${axis}`, explanationsRaw[axis], 5000),
        ]),
      ),
      recommendations: Object.fromEntries(
        Object.entries(source.recommendations).map(([dimension, items]) => [
          dimension,
          list(`recommendations.${dimension}`, recommendationsRaw[dimension], items.length, 2500),
        ]),
      ),
      roadmap: roadmapRaw.map((step, i) => {
        const item = (step ?? {}) as Record<string, unknown>;
        return {
          title: str(`roadmap[${i}].title`, item.title, 400),
          description:
            source.roadmap[i]?.description === null
              ? null
              : str(`roadmap[${i}].description`, item.description, 4000),
        };
      }),
    };
  }
}
