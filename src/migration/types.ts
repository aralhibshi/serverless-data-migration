import type { z } from 'zod';

import type { MigrationTrackingEntity } from '../entities/DDB/MigrationTrackingEntity';
import type { MigrationMessage } from './migrationMessage';

/** A flat, human-readable view of a record's state, stored with tracking and used as report columns. */
export type StateSummary = Record<string, string>;

/**
 * One way of migrating a kind of record (the strategy pattern). This is the extension point:
 * each migration supplies a use case per kind of record, and exactly one must apply to each record.
 */
export interface MigrationUseCase<TOld, TNew> {
  readonly name: string;
  appliesTo(record: TOld): boolean;
  /** Pure: returns the new state. Throws PermanentMigrationError when the record can't be migrated. */
  migrate(record: TOld): TNew;
}

/** A record as read from the source, classified by where it is in the migration. */
export type SourceRecord<TOld, TNew> =
  | { readonly status: 'pending'; readonly recordId: string; readonly record: TOld }
  | { readonly status: 'migrated'; readonly recordId: string; readonly record: TNew }
  | { readonly status: 'invalid'; readonly recordId: string; readonly reason: string }
  | { readonly status: 'missing'; readonly recordId: string };

export type SaveResult = 'saved' | 'already-migrated';

/** Where the records live. Implementations own the storage details. */
export interface MigrationSource<TOld, TNew, TFilter> {
  /** Yields every record that hasn't been migrated yet and matches the filter, as `pending` or `invalid`. */
  findPending(filter: TFilter): AsyncIterable<SourceRecord<TOld, TNew>>;
  /** Reads one record with a strongly consistent read. */
  load(recordId: string): Promise<SourceRecord<TOld, TNew>>;
  /**
   * Writes the new state only if the record still matches `previous`. Returns `already-migrated` if another
   * attempt got there first, and throws (so the record is retried) if live traffic changed it in the meantime.
   */
  save(previous: TOld, next: TNew): Promise<SaveResult>;
}

/** Everything the pipeline needs to know about one migration. */
export interface Migration<TOld, TNew, TFilter> {
  /** Stable id; tracking and reports are keyed by it, which is what makes re-runs resumable. */
  readonly id: string;
  readonly filterSchema: z.ZodType<TFilter>;
  readonly source: MigrationSource<TOld, TNew, TFilter>;
  readonly useCases: readonly MigrationUseCase<TOld, TNew>[];
  summarizeOld(record: TOld): StateSummary;
  summarizeNew(record: TNew): StateSummary;
}

// Tracking: every record's outcome is recorded, so nothing can fail silently.

export interface QueuedRecord {
  readonly recordId: string;
  readonly before: StateSummary;
}

export interface SucceededRecord {
  readonly migrationId: string;
  readonly recordId: string;
  readonly useCase?: string;
  readonly before?: StateSummary;
  readonly after: StateSummary;
}

export interface FailedRecord {
  readonly migrationId: string;
  readonly recordId: string;
  readonly reason: string;
}

export interface TrackingRepository {
  /** Starts (or restarts) tracking for records about to be queued, clearing any earlier outcome. */
  markQueued(migrationId: string, records: readonly QueuedRecord[]): Promise<void>;
  markSucceeded(record: SucceededRecord): Promise<void>;
  /** Marks a record failed. Never overwrites a success. */
  markFailed(record: FailedRecord): Promise<void>;
  /** Notes a retryable error and counts the attempt. */
  recordAttemptError(migrationId: string, recordId: string, error: string): Promise<void>;
  get(migrationId: string, recordId: string): Promise<MigrationTrackingEntity | undefined>;
  list(migrationId: string): Promise<MigrationTrackingEntity[]>;
}

/** Where the orchestrator sends one message per record. */
export interface RecordQueue {
  send(messages: readonly MigrationMessage[]): Promise<void>;
}
