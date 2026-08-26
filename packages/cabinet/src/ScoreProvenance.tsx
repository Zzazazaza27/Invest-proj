import type { InvestmentPassport } from '@unicorn/contracts';

/**
 * Балл и его происхождение — неотделимо (promt_aiscoring.md, раздел 5; ADR-008 §4).
 *
 * Число «8/10» рядом с проектом читается как оценка привлекательности вложения,
 * что бы ни лежало в служебных полях. Поэтому балл не отображается без блока
 * происхождения: оценка сгенерирована ИИ, версия модели, дата, версия заявки,
 * сведения заявителя платформой не проверялись. Дисклеймер — константа
 * приложения, не поле ответа модели: то, что платно генерируется в каждом
 * прогоне, в каждом прогоне может быть слегка переписано.
 *
 * `integrityFlags` здесь не выводятся: это внутренний сигнал безопасности, его
 * место в журнале, а не в кабинете.
 */

export const SCORE_DISCLAIMER =
  'Оценка сгенерирована ИИ по тексту заявки и не является рекомендацией. ' +
  'Сведения заявителя платформой не проверялись.';

/** Публикуемый балл из паспорта: после решения человека по потолкам. */
export function publishedScore10(passport: InvestmentPassport | null | undefined): number | null {
  const value = passport?.data?.score10Published;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function translationPending(passport: InvestmentPassport | null | undefined): boolean {
  return passport?.data?.translationPending === true;
}

export function ScoreProvenance({
  passport,
  modelVersion,
  compact = false,
}: {
  passport: InvestmentPassport;
  modelVersion: string | null;
  compact?: boolean;
}) {
  const score = publishedScore10(passport);
  const date = passport.publishedAt
    ? new Date(passport.publishedAt).toLocaleDateString('ru-RU')
    : null;
  const pending = passport.data?.review === undefined ? null : passport.data.review;
  const reviewPending =
    typeof pending === 'object' &&
    pending !== null &&
    (pending as { status?: string }).status === 'pending';

  return (
    <div
      style={{
        display: 'grid',
        gap: compact ? 'var(--u-space-1)' : 'var(--u-space-2)',
        fontSize: 'var(--u-text-sm)',
        color: 'var(--u-text-muted)',
      }}
    >
      {score !== null ? (
        <strong
          style={{
            color: 'var(--u-text)',
            fontSize: compact ? 'var(--u-text-md)' : 'var(--u-text-lg)',
          }}
        >
          {score}/10
          {reviewPending ? (
            <span style={{ fontWeight: 400, color: 'var(--u-text-muted)' }}>
              {' '}
              · базовый балл, ждёт решения оператора по потолкам
            </span>
          ) : null}
        </strong>
      ) : null}
      <span>
        Оценка сгенерирована ИИ · модель {modelVersion ?? 'не указана'} · паспорт версии{' '}
        {passport.version}
        {date ? ` · ${date}` : ''}
      </span>
      <span>{SCORE_DISCLAIMER}</span>
      {translationPending(passport) ? <span>Оригинал на русском, перевод готовится.</span> : null}
    </div>
  );
}
