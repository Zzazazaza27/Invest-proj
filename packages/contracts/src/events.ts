import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './common/primitives';

/**
 * Событийные контракты (NATS JetStream, стрим LAUNCH).
 *
 * Это публичный контракт для Unicorn Capital и медиаконтура Шоу. Меняется
 * только расширением: добавление необязательного поля — можно, удаление или
 * смена типа — новая `schemaVersion`.
 */

export const EVENT_STREAM = 'LAUNCH' as const;

export const EventVerb = {
  PROJECT_SUBMITTED: 'lab.project.submitted',
  PROJECT_SCORED: 'lab.project.scored',
  PROJECT_STATUS_CHANGED: 'lab.project.status_changed',
  PROJECT_GRADUATED: 'lab.project.graduated',
  LISTING_PUBLISHED: 'lab.listing.published',
  LISTING_UNPUBLISHED: 'lab.listing.unpublished',
  IRS_RECALCULATED: 'lab.irs.recalculated',
  OFFER_PUBLISHED: 'investment.offer.published',
  AGREEMENT_SIGNED: 'investment.agreement.signed',
  FIRST_TRANCHE_CONFIRMED: 'investment.first_tranche.confirmed',
  AGREEMENT_EFFECTIVE: 'investment.agreement.effective',
  COMMISSION_ACCRUED: 'billing.commission.accrued',
  PAYMENT_SUCCEEDED: 'lab.payment.succeeded',
  SEASON_OPENED: 'lab.season.opened',
  SEASON_CLOSED: 'lab.season.closed',
  RATING_PUBLISHED: 'lab.rating.published',
  CONSENT_PUBLICATION_GRANTED: 'lab.consent.publication_granted',
  CONSENT_PUBLICATION_REVOKED: 'lab.consent.publication_revoked',
  CONSENSUS_DECIDED: 'lab.consensus.decided',
  EXPERT_ASSIGNED: 'lab.expert.assigned',
  EXPERT_ASSIGNMENT_CLOSED: 'lab.expert.assignment_closed',
  EXPERT_REVIEW_SUBMITTED: 'lab.expert.review_submitted',
  EXPERT_CONFLICT_DECLARED: 'lab.expert.conflict_declared',
  EXPERT_CONFLICT_RESOLVED: 'lab.expert.conflict_resolved',
  GOLDEN_TICKET_GRANTED: 'lab.golden_ticket.granted',
} as const;

export type EventVerbValue = (typeof EventVerb)[keyof typeof EventVerb];

/** Конверт события. Одинаков для всех verb'ов. */
export const EventEnvelopeSchema = z.object({
  eventId: UuidSchema,
  verb: z.string(),
  schemaVersion: z.number().int().positive(),
  occurredAt: IsoDateTimeSchema,
  /** Ключ партиционирования: гарантирует порядок в пределах агрегата. */
  aggregateType: z.string(),
  aggregateId: UuidSchema,
  aggregateVersion: z.number().int().nonnegative(),
  traceId: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

// ------------------------------------------------------- полезные нагрузки

export const ProjectGraduatedPayloadSchema = z.object({
  projectId: UuidSchema,
  seasonId: UuidSchema.nullable(),
  irs: z.number().min(0).max(100).nullable(),
  taxonomyId: UuidSchema.nullable(),
});

export const ListingPublishedPayloadSchema = z.object({
  projectId: UuidSchema,
  investmentAsk: z.string(),
  currency: z.literal('RUB'),
  taxonomyId: UuidSchema.nullable(),
});

export const FirstTrancheConfirmedPayloadSchema = z.object({
  agreementId: UuidSchema,
  trancheId: UuidSchema,
  amount: z.string(),
  bookedAt: IsoDateTimeSchema,
});

export const AgreementEffectivePayloadSchema = z.object({
  agreementId: UuidSchema,
  effectiveAt: IsoDateTimeSchema,
});

/**
 * Начисление вознаграждения. Персональные данные сторон в событие НЕ попадают:
 * потребители (Capital, аналитика) получают агрегат, а не ПДн.
 */
export const CommissionAccruedPayloadSchema = z.object({
  accrualId: UuidSchema,
  agreementId: UuidSchema,
  baseAmount: z.string(),
  currency: z.literal('RUB'),
  investorFeePct: z.string(),
  issuerFeePct: z.string(),
});

/** Отзыв согласия на публичность: медиаконтур обязан удалить проекцию ≤15 мин. */
export const PublicationConsentRevokedPayloadSchema = z.object({
  projectId: UuidSchema,
  userId: UuidSchema,
  scope: z.string(),
  revokedAt: IsoDateTimeSchema,
  /** Крайний срок удаления проекции. Нарушение — инцидент, а не задержка. */
  deletionDeadline: IsoDateTimeSchema,
});

/** Реестр: verb → схема полезной нагрузки. Неизвестный verb не публикуется. */
export const EVENT_PAYLOAD_SCHEMAS = {
  [EventVerb.PROJECT_GRADUATED]: ProjectGraduatedPayloadSchema,
  [EventVerb.LISTING_PUBLISHED]: ListingPublishedPayloadSchema,
  [EventVerb.FIRST_TRANCHE_CONFIRMED]: FirstTrancheConfirmedPayloadSchema,
  [EventVerb.AGREEMENT_EFFECTIVE]: AgreementEffectivePayloadSchema,
  [EventVerb.COMMISSION_ACCRUED]: CommissionAccruedPayloadSchema,
  [EventVerb.CONSENT_PUBLICATION_REVOKED]: PublicationConsentRevokedPayloadSchema,
} as const;

/** Срок удаления публичной проекции после отзыва согласия. */
export const PUBLICATION_DELETION_SLA_MINUTES = 15;
