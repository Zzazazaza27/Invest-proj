import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { CryptoService } from '../crypto/crypto.service';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import type { ProviderCredential } from './ai-gateway.client';

/**
 * Ключ LLM-провайдера, заданный из панели (ADR-008 §2).
 *
 * Три правила, ради которых сервис отдельный:
 *
 *  1. **Ключ не читается обратно.** Наружу уходят отпечаток, имя модели, кто и
 *     когда задал. Расшифровка происходит только внутри прогона анализа — и
 *     результат немедленно уезжает в шлюз, не задерживаясь ни в логе, ни в
 *     ошибке.
 *  2. **Провайдер — только из закрытого списка.** Список совпадает с `CHECK`
 *     таблицы и с политикой шлюза; адрес провайдера здесь не задаётся.
 *  3. **Каждое изменение — в журнал.** Задать, сменить или отозвать ключ —
 *     операция с деньгами, и у неё есть автор и основание.
 */

export const LLM_PROVIDERS = [
  'yandex_gpt',
  'gigachat',
  'anthropic',
  'openai',
  'kimi',
  'qwen',
  'deepseek',
] as const;

/**
 * Версия промпта, под которую проходит eval-гейт.
 *
 * Обязана совпадать с `PROMPT_VERSION` шлюза (`apps/ai-gateway/app/llm.py`):
 * строка версии модели в `scoring.score_models` собирается отсюда, и по ней
 * читается, «какой рубрикой посчитан паспорт» (ADR-008 §1, §6).
 *
 * Дублирование здесь не от лени: ядро выбирает `model_id` ДО обращения к
 * шлюзу, а eval-гейт проверяет версию, когда шлюз может быть не поднят. Но
 * дублирование, которое никто не сверяет, расходится молча — и разошлось:
 * шлюз перешёл на v2.6, ядро осталось на v2.5.2, и паспорта получали бы метку
 * рубрики, которой их не считали. Поэтому совпадение проверяется тестом
 * (`apps/core/tests/ai.test.ts`), который читает файл шлюза, и вторым разом —
 * на самом прогоне: ответ шлюза с чужой версией промпта не записывается.
 */
export const PROMPT_VERSION = 'v2.6';

export function llmModelVersion(provider: string, model: string | null): string {
  return `llm:${provider}:${model ?? 'default'}:${PROMPT_VERSION}`;
}
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export interface ProviderCredentialView {
  provider: LlmProvider;
  keyFingerprint: string;
  modelName: string | null;
  isActive: boolean;
  setBy: string;
  setAt: string;
  lastCheckedAt: string | null;
  lastCheckOk: boolean | null;
}

interface CredentialRow {
  provider: LlmProvider;
  api_key_ciphertext: Buffer;
  wrapped_dek: Buffer;
  key_fingerprint: string;
  model_name: string | null;
  is_active: boolean;
  set_by: string;
  set_at: Date;
  last_checked_at: Date | null;
  last_check_ok: boolean | null;
}

const KEY_MIN = 8;
const KEY_MAX = 512;
/** Постоянный AAD: ротация KEK (rotate-kek.mjs) проверяет ключ пробной расшифровкой с ним. */
const CREDENTIAL_AAD = 'field:api_key';

@Injectable()
export class ProviderCredentialsService {
  constructor(
    private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly audit: AuditRepository,
  ) {}

  /** Список для панели: без ключей, только метаданные. */
  async list(ctx: RequestContext): Promise<ProviderCredentialView[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<CredentialRow>(
        `SELECT provider, api_key_ciphertext, wrapped_dek, key_fingerprint, model_name,
                is_active, set_by, set_at, last_checked_at, last_check_ok
           FROM scoring.ai_provider_credentials
          ORDER BY is_active DESC, set_at DESC`,
      );
      return rows.map(mapView);
    });
  }

  /**
   * Задать или сменить ключ. Новый ключ делает провайдера активным и снимает
   * активность с прежнего: активный провайдер на платформе один.
   */
  async upsert(
    ctx: RequestContext,
    input: { provider: LlmProvider; apiKey: string; modelName: string | null; reason: string },
  ): Promise<ProviderCredentialView> {
    if (!LLM_PROVIDERS.includes(input.provider)) {
      throw errors.validation([{ path: 'provider', message: 'неизвестный провайдер' }]);
    }
    const apiKey = input.apiKey.trim();
    if (apiKey.length < KEY_MIN || apiKey.length > KEY_MAX) {
      throw errors.validation([
        { path: 'apiKey', message: `ключ от ${KEY_MIN} до ${KEY_MAX} символов` },
      ]);
    }
    if (/\s/.test(apiKey)) {
      throw errors.validation([{ path: 'apiKey', message: 'ключ не содержит пробелов' }]);
    }

    const sealed = this.crypto.seal('ai_provider_secrets', apiKey, CREDENTIAL_AAD);
    const fingerprint = createHash('sha256').update(apiKey).digest('hex').slice(0, 12);

    return this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE scoring.ai_provider_credentials SET is_active = false WHERE is_active`,
      );
      const { rows } = await tx.query<CredentialRow>(
        `INSERT INTO scoring.ai_provider_credentials
           (provider, api_key_ciphertext, wrapped_dek, key_fingerprint, model_name,
            is_active, set_by, set_at, last_checked_at, last_check_ok)
         VALUES ($1, $2, $3, $4, $5, true, $6, now(), NULL, NULL)
         ON CONFLICT (provider) DO UPDATE
           SET api_key_ciphertext = EXCLUDED.api_key_ciphertext,
               wrapped_dek        = EXCLUDED.wrapped_dek,
               key_fingerprint    = EXCLUDED.key_fingerprint,
               model_name         = EXCLUDED.model_name,
               is_active          = true,
               set_by             = EXCLUDED.set_by,
               set_at             = now(),
               last_checked_at    = NULL,
               last_check_ok      = NULL
         RETURNING provider, api_key_ciphertext, wrapped_dek, key_fingerprint, model_name,
                   is_active, set_by, set_at, last_checked_at, last_check_ok`,
        [
          input.provider,
          sealed.ciphertext,
          sealed.wrappedDek,
          fingerprint,
          input.modelName?.trim() || null,
          ctx.userId,
        ],
      );
      await this.audit.emit(tx, {
        verb: 'admin.ai_provider_credential.set',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'ai_provider_credential',
        subjectId: null,
        // Отпечаток — да, ключ — никогда: журнал неизменяем.
        context: {
          provider: input.provider,
          fingerprint,
          model: input.modelName,
          reason: input.reason,
        },
        traceId: ctx.traceId,
      });
      return mapView(rows[0]!);
    });
  }

  /** Отозвать ключ: строка удаляется, факт остаётся в журнале. */
  async revoke(ctx: RequestContext, provider: LlmProvider, reason: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `DELETE FROM scoring.ai_provider_credentials WHERE provider = $1`,
        [provider],
      );
      if (!rowCount) throw errors.notFound({ subject: 'ai_provider_credential' });
      await this.audit.emit(tx, {
        verb: 'admin.ai_provider_credential.revoked',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'ai_provider_credential',
        subjectId: null,
        context: { provider, reason },
        traceId: ctx.traceId,
      });
    });
  }

  async recordCheck(ctx: RequestContext, provider: LlmProvider, ok: boolean): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      await tx.query(
        `UPDATE scoring.ai_provider_credentials
            SET last_checked_at = now(), last_check_ok = $2
          WHERE provider = $1`,
        [provider, ok],
      );
    });
  }

  /**
   * Активный ключ в открытом виде — только для прогона анализа и проверки.
   * Возвращается объектом, который сразу уходит в шлюз; вызывающая сторона не
   * логирует и не сохраняет его.
   */
  async activeForCall(tx: Tx): Promise<ProviderCredential | null> {
    const { rows } = await tx.query<CredentialRow>(
      `SELECT provider, api_key_ciphertext, wrapped_dek, key_fingerprint, model_name,
              is_active, set_by, set_at, last_checked_at, last_check_ok
         FROM scoring.ai_provider_credentials
        WHERE is_active
        LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const apiKey = this.crypto
      .open(
        'ai_provider_secrets',
        { ciphertext: row.api_key_ciphertext, wrappedDek: row.wrapped_dek },
        CREDENTIAL_AAD,
      )
      .toString('utf8');
    return { provider: row.provider, apiKey, model: row.model_name };
  }

  /** Ключ конкретного провайдера для проверки из панели. */
  async forCheck(ctx: RequestContext, provider: LlmProvider): Promise<ProviderCredential | null> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<CredentialRow>(
        `SELECT provider, api_key_ciphertext, wrapped_dek, key_fingerprint, model_name,
                is_active, set_by, set_at, last_checked_at, last_check_ok
           FROM scoring.ai_provider_credentials
          WHERE provider = $1`,
        [provider],
      );
      const row = rows[0];
      if (!row) return null;
      const apiKey = this.crypto
        .open(
          'ai_provider_secrets',
          { ciphertext: row.api_key_ciphertext, wrappedDek: row.wrapped_dek },
          CREDENTIAL_AAD,
        )
        .toString('utf8');
      return { provider: row.provider, apiKey, model: row.model_name };
    });
  }
}

function mapView(row: CredentialRow): ProviderCredentialView {
  return {
    provider: row.provider,
    keyFingerprint: row.key_fingerprint,
    modelName: row.model_name,
    isActive: row.is_active,
    setBy: row.set_by,
    setAt: row.set_at.toISOString(),
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    lastCheckOk: row.last_check_ok,
  };
}
