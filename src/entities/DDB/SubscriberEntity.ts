import { z } from 'zod';

import type { SourceRecord } from '../../migration/types';

/*
 * An invented, simplified subscription model for the worked example.
 *
 * Old (schema version 1): subscribers chose a fixed box size, and a pause was a bare date.
 * New (schema version 2): subscribers have a meals-per-week plan and an explicit pause object.
 *
 * Both live in the subscribers table (partition key `subscriberId`), told apart by `schemaVersion`.
 */

export const boxSizes = ['small', 'medium', 'large'] as const;
export const subscriptionStatuses = ['active', 'paused', 'cancelled'] as const;

export type BoxSize = (typeof boxSizes)[number];

export const legacySubscriberSchema = z.object({
  subscriberId: z.string().min(1),
  schemaVersion: z.literal(1),
  boxSize: z.enum(boxSizes),
  status: z.enum(subscriptionStatuses),
  pausedUntil: z.iso.date().optional(),
});

export const subscriberSchema = z.object({
  subscriberId: z.string().min(1),
  schemaVersion: z.literal(2),
  status: z.enum(subscriptionStatuses),
  plan: z.object({ mealsPerWeek: z.number().int().positive() }).nullable(),
  pause: z.object({ resumesOn: z.iso.date() }).nullable(),
  /** Kept for audit, so the old state can always be traced. */
  migratedFrom: z.object({ boxSize: z.enum(boxSizes) }),
});

/** Optional filter for the orchestrator, for example to migrate one box size first. */
export const subscriberFilterSchema = z.strictObject({
  boxSizes: z.array(z.enum(boxSizes)).min(1).optional(),
});

export type LegacySubscriber = z.infer<typeof legacySubscriberSchema>;
export type Subscriber = z.infer<typeof subscriberSchema>;
export type SubscriberFilter = z.infer<typeof subscriberFilterSchema>;

/** A subscriber as stored, classified by where it is in the migration. */
export type SubscriberEntity = SourceRecord<LegacySubscriber, Subscriber>;

/** Zod's readable error, on one line so it fits a report cell. */
function describeIssues(error: z.ZodError): string {
  return z.prettifyError(error).replaceAll(/\s*\n\s*/g, ' ');
}

/** Maps a raw item to an entity: already on the new schema, valid on the old one, or invalid. */
export function toSubscriberEntity(item: Record<string, unknown>): SubscriberEntity {
  const recordId = typeof item.subscriberId === 'string' ? item.subscriberId : '(missing subscriberId)';

  if (item.schemaVersion === 2) {
    const migrated = subscriberSchema.safeParse(item);
    return migrated.success
      ? { status: 'migrated', recordId, record: migrated.data }
      : { status: 'invalid', recordId, reason: `Invalid migrated record: ${describeIssues(migrated.error)}` };
  }

  const legacy = legacySubscriberSchema.safeParse(item);
  return legacy.success
    ? { status: 'pending', recordId, record: legacy.data }
    : { status: 'invalid', recordId, reason: `Invalid record: ${describeIssues(legacy.error)}` };
}
