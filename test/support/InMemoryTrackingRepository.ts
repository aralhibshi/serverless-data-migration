import type { MigrationTrackingEntity } from '../../src/entities/DDB/MigrationTrackingEntity';
import type { FailedRecord, QueuedRecord, SucceededRecord, TrackingRepository } from '../../src/migration/types';

export const NOW = '2026-01-01T00:00:00.000Z';

/** Mirrors MigrationTrackingRepository's semantics in memory, for unit tests. */
export class InMemoryTrackingRepository implements TrackingRepository {
  readonly entries = new Map<string, MigrationTrackingEntity>();
  readonly calls: string[] = [];

  async markQueued(migrationId: string, records: readonly QueuedRecord[]): Promise<void> {
    this.calls.push(`markQueued:${String(records.length)}`);
    for (const { recordId, before } of records) {
      this.entries.set(key(migrationId, recordId), {
        migrationId,
        recordId,
        status: 'queued',
        before,
        attempts: 0,
        updatedAt: NOW,
      });
    }
    return Promise.resolve();
  }

  async markSucceeded({ migrationId, recordId, useCase, before, after }: SucceededRecord): Promise<void> {
    const existing = this.entries.get(key(migrationId, recordId));
    const { reason: _reason, ...rest } = existing ?? { migrationId, recordId, attempts: 0 };
    this.entries.set(key(migrationId, recordId), {
      ...rest,
      status: 'succeeded',
      after,
      updatedAt: NOW,
      ...(useCase === undefined ? {} : { useCase }),
      ...(before === undefined ? {} : { before }),
    });
    return Promise.resolve();
  }

  async markFailed({ migrationId, recordId, reason }: FailedRecord): Promise<void> {
    const existing = this.entries.get(key(migrationId, recordId));
    if (existing?.status === 'succeeded') return;
    this.entries.set(key(migrationId, recordId), {
      ...(existing ?? { migrationId, recordId, attempts: 0 }),
      status: 'failed',
      reason,
      updatedAt: NOW,
    });
    return Promise.resolve();
  }

  async recordAttemptError(migrationId: string, recordId: string, error: string): Promise<void> {
    const existing = this.entries.get(key(migrationId, recordId));
    this.entries.set(key(migrationId, recordId), {
      ...(existing ?? { migrationId, recordId, status: 'queued', attempts: 0 }),
      lastError: error,
      attempts: (existing?.attempts ?? 0) + 1,
      updatedAt: NOW,
    });
    return Promise.resolve();
  }

  get(migrationId: string, recordId: string): Promise<MigrationTrackingEntity | undefined> {
    return Promise.resolve(this.entries.get(key(migrationId, recordId)));
  }

  list(migrationId: string): Promise<MigrationTrackingEntity[]> {
    return Promise.resolve(
      [...this.entries.values()]
        .filter((entry) => entry.migrationId === migrationId)
        .sort((a, b) => a.recordId.localeCompare(b.recordId)),
    );
  }
}

function key(migrationId: string, recordId: string): string {
  return `${migrationId}#${recordId}`;
}
