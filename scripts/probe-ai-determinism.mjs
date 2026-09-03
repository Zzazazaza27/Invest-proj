#!/usr/bin/env node
/**
 * Зонд детерминизма LLM-скоринга: откуда разброс IRS между прогонами.
 *
 * Один и тот же вход гоняется через шлюз двумя сериями: с фиксированным
 * nonce (промпт побайтно одинаков) и со случайным (как в бою). Если разброс
 * есть только во второй серии — источник дисперсии сам nonce в маркерах
 * слота, а не семплер; если в обеих — семплер/хостинг провайдера.
 *
 *   node scripts/probe-ai-determinism.mjs            # по 4 вызова в серии
 *   node scripts/probe-ai-determinism.mjs --runs 6
 *
 * Требует запущенного ai-gateway и активного ключа провайдера (как eval).
 */
import pg from 'pg';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();
const GATEWAY = process.env.AI_GATEWAY_URL || `http://127.0.0.1:${PORTS.aiGateway}`;
const TOKEN = process.env.AI_GATEWAY_TOKEN ?? '';
const argv = process.argv.slice(2);
const runs = Number(argv[argv.indexOf('--runs') + 1] || 4);

function loadDotEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    process.env[t.slice(0, eq).trim()] ??= t.slice(eq + 1).trim();
  }
}

function decrypt(key, payload, aad) {
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const body = payload.subarray(28);
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAuthTag(tag);
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([d.update(body), d.final()]);
}

const WEIGHTS = {
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

const PROJECT = {
  title: 'Платформа предиктивного обслуживания станков',
  summary:
    'SaaS для заводов: датчики вибрации и температуры, модель предсказывает отказ за 3–7 дней. ' +
    'Пилоты на 4 предприятиях, 2 платящих клиента, выручка 1,8 млн ₽ в месяц, команда 6 человек.',
  stage: 'early_revenue',
  materials: [{ type: 'deck' }],
  metadata: {
    investmentAsk: '25000000.00',
    currency: 'RUB',
    taxonomy: 'Промышленность',
    geoCountry: 'RU',
  },
};

async function main() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 1 });
  const { rows } = await pool.query(
    `SELECT provider, api_key_ciphertext, wrapped_dek, model_name
       FROM scoring.ai_provider_credentials WHERE is_active LIMIT 1`,
  );
  await pool.end();
  const row = rows[0];
  if (!row) throw new Error('нет активного ключа провайдера');
  // Правило SAST срабатывает на ИМЯ переменной `kek`. Секрета в коде нет:
  // значение приходит из окружения, а ключ провайдера лежит в базе
  // шифртекстом и расшифровывается ниже. Та же оговорка — в ядре и rotate-kek.
  // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
  const kek = Buffer.from(process.env.KEK_AI_PROVIDER_SECRETS ?? '', 'base64');
  const dek = decrypt(kek, row.wrapped_dek, 'wrap:ai_provider_secrets');
  const apiKey = decrypt(dek, row.api_key_ciphertext, 'field:api_key').toString('utf8');

  async function analyze(nonce) {
    const response = await fetch(`${GATEWAY}/v1/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        task: 'project_analysis',
        data_class: 'pseudonymous',
        provider: row.provider,
        provider_credential: { api_key: apiKey, model: row.model_name },
        project: { ...PROJECT, nonce },
        trace_id: `probe-${nonce.slice(0, 8)}`,
      }),
      signal: AbortSignal.timeout(600_000),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.scores)
      return { irs: null, code: json?.detail?.code ?? response.status };
    const irs =
      Math.round(json.scores.reduce((s, x) => s + x.value * WEIGHTS[x.axis], 0) * 10) / 10;
    return { irs, axes: Object.fromEntries(json.scores.map((s) => [s.axis, s.value])) };
  }

  const fixed = randomBytes(16).toString('hex');
  const series = [
    ['фиксированный nonce', () => fixed],
    ['случайный nonce', () => randomBytes(16).toString('hex')],
  ];
  for (const [name, nonceOf] of series) {
    const out = [];
    for (let i = 0; i < runs; i += 1) out.push(await analyze(nonceOf()));
    const irs = out.map((o) => o.irs).filter((v) => v !== null);
    const spread = irs.length ? Math.max(...irs) - Math.min(...irs) : NaN;
    console.warn(`${name}: IRS ${irs.join(', ')} — разброс ${spread.toFixed(1)}`);
    const axes = new Set(out.flatMap((o) => Object.keys(o.axes ?? {})));
    for (const axis of axes) {
      const values = out.map((o) => o.axes?.[axis]).filter((v) => v !== undefined);
      if (new Set(values).size > 1) console.warn(`   ${axis}: ${values.join(' ')}`);
    }
  }
}

main().catch((error) => {
  console.error('зонд прерван:', error?.message ?? error);
  process.exit(1);
});
