import { Badge } from '@unicorn/ui';
import type { ApplicationDetail } from '@unicorn/contracts';
import { S } from '../strings';

/**
 * Готовность заявки — два разных сообщения (решение владельца 2026-09-15):
 *
 *  1. выполнен ли МИНИМУМ для подачи (обязательные вопросы и сумма);
 *  2. общий процент заполненности с учётом рекомендуемых вопросов.
 *
 * Минимум выполнен при 19% — нормальная ситуация: подача открыта, а процент
 * лишь подсказывает, что рекомендуемые вопросы сделают заявку сильнее.
 * Поэтому первое сообщение — про подачу, второе — без окраски «ошибки».
 */
export function ReadinessPanel({ detail }: { detail: ApplicationDetail }) {
  const { readiness, submission } = detail;
  const mandatoryLeft = readiness.missingMandatory.length;
  const minimumDone = readiness.canSubmit;

  return (
    <div
      data-readiness
      style={{
        display: 'grid',
        gap: 'var(--u-space-2)',
        padding: 'var(--u-space-4)',
        borderRadius: 'var(--u-radius-lg)',
        background: minimumDone
          ? 'var(--u-success-subtle)'
          : 'var(--u-surface-muted, var(--u-surface))',
        border: '1px solid var(--u-border)',
      }}
    >
      <div
        style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Badge tone={minimumDone ? 'success' : 'accent'}>
          {minimumDone
            ? S.wizard.readiness.minimumDone
            : S.wizard.readiness.minimumLeft(mandatoryLeft)}
        </Badge>
        {minimumDone && !submission.canSubmit ? (
          <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
            {S.wizard.readiness.policyBlock}: {submission.missing.map((m) => m.message).join('; ')}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gap: 'var(--u-space-1)' }}>
        <div
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--u-text-sm)' }}
        >
          <strong>{S.wizard.readiness.percent(readiness.percent)}</strong>
        </div>
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={readiness.percent}
          aria-label="Заполненность заявки"
          style={{
            height: 8,
            borderRadius: 'var(--u-radius-pill)',
            background: 'var(--u-border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${readiness.percent}%`,
              height: '100%',
              background: 'var(--u-accent)',
              transition: 'width var(--u-transition)',
            }}
          />
        </div>
        <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
          {S.wizard.readiness.percentHint}
        </span>
      </div>
    </div>
  );
}
