import { createHash } from 'node:crypto';

/**
 * Отпечаток содержимого предпросмотра (5.7.4, уточнение владельца).
 *
 * Проверки одной версии условий недостаточно: между предпросмотром и
 * подтверждением могли измениться сами ответы заявки или параметры раунда —
 * в том числе из другой вкладки. Предпросмотр отдаёт отпечаток того, что
 * показал; подача, открытие раунда и «Применить» возвращают его, и сервер
 * пересчитывает отпечаток по текущему состоянию. Расхождение — 409 и
 * предложение обновить предпросмотр. Запрет кнопки в интерфейсе этой
 * проверки не заменяет.
 *
 * Отпечаток — SHA-256 канонического JSON (ключи отсортированы), первые 32
 * шестнадцатеричных знака: коллизии здесь не угроза, а случайность.
 */
export function contentDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** Содержимое черновика заявки, которое покажет предпросмотр и зафиксирует подача. */
export function applicationDigest(application: {
  schemaVersion: number;
  stage: string;
  title: string | null;
  businessType: string | null;
  fundingScope: string | null;
  fundingScopeNote: string | null;
  investmentAsk: string | null;
  askCurrency: string;
  answers: Record<string, unknown>;
  evidence: Record<string, unknown>;
}): string {
  return contentDigest({
    schemaVersion: application.schemaVersion,
    stage: application.stage,
    title: application.title,
    businessType: application.businessType,
    fundingScope: application.fundingScope,
    fundingScopeNote: application.fundingScopeNote,
    investmentAsk: application.investmentAsk,
    askCurrency: application.askCurrency,
    answers: application.answers,
    evidence: application.evidence,
  });
}

/** Параметры раунда, которые раскрываются после открытия или применения условий. */
export function roundDigest(round: {
  id: string;
  status: string;
  target: string | null;
  currency: string | null;
  fundingScope: string | null;
  fundingScopeNote: string | null;
  investorMode: string | null;
  ticketMin: string | null;
  ticketMax: string | null;
  answers: Record<string, unknown>;
  evidence: Record<string, unknown>;
}): string {
  return contentDigest({
    id: round.id,
    status: round.status,
    target: round.target,
    currency: round.currency,
    fundingScope: round.fundingScope,
    fundingScopeNote: round.fundingScopeNote,
    investorMode: round.investorMode,
    ticketMin: round.ticketMin,
    ticketMax: round.ticketMax,
    answers: round.answers,
    evidence: round.evidence,
  });
}

/**
 * Содержимое, которое расширяет «Применить новые условия»: согласованный
 * снимок (неизменяем — достаточно идентификатора), режим проекта и параметры
 * незавершённого раунда, если он есть.
 */
export function disclosureDigest(input: {
  disclosedVersionId: string | null;
  visibility: string;
  round: Parameters<typeof roundDigest>[0] | null;
}): string {
  return contentDigest({
    disclosedVersionId: input.disclosedVersionId,
    visibility: input.visibility,
    round: input.round ? roundDigest(input.round) : null,
  });
}
