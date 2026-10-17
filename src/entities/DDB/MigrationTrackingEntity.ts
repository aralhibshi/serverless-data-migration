import { z } from 'zod';

export const trackingStatuses = ['queued', 'succeeded', 'failed'] as const;
export type TrackingStatus = (typeof trackingStatuses)[number];

const stateSummarySchema = z.record(z.string(), z.string());

/**
 * One per record per migration: the record's latest outcome. Stored in the tracking table under
 * partition key `migrationId` and sort key `recordId`, so one query returns a whole migration.
 */
export const migrationTrackingEntitySchema = z.object({
  migrationId: z.string(),
  recordId: z.string(),
  status: z.enum(trackingStatuses),
  useCase: z.string().optional(),
  before: stateSummarySchema.optional(),
  after: stateSummarySchema.optional(),
  /** Why the record failed (set when status is `failed`). */
  reason: z.string().optional(),
  /** The most recent retryable error, kept so the failure handler can explain a dead-lettered record. */
  lastError: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export type MigrationTrackingEntity = z.infer<typeof migrationTrackingEntitySchema>;
