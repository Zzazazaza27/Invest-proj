import { z } from 'zod';
import { IsoDateTimeSchema, UuidSchema } from './common/primitives';

/**
 * Событийные контракты (NATS JetStream, стрим LAUNCH).
 *
 * Это публичный контракт для внешних потребителей. Меняется
 * только расширением: добавление необязательного поля — можно, удаление или
 * смена типа — новая `schemaVersion`.
 */

export const EVENT_STREAM = 'LAUNCH' as const;

export const EventVerb = {
  LISTING_PUBLISHED: 'lab.listing.published',
  LISTING_UNPUBLISHED: 'lab.listing.unpublished',
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

export const ListingPublishedPayloadSchema = z.object({
  projectId: UuidSchema,
  investmentAsk: z.string(),
  currency: z.literal('RUB'),
  taxonomyId: UuidSchema.nullable(),
});

export const EVENT_PAYLOAD_SCHEMAS = {
  [EventVerb.LISTING_PUBLISHED]: ListingPublishedPayloadSchema,
} as const;
