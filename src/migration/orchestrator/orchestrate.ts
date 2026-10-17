import { z } from 'zod';

import { SQS_MAX_BATCH_SIZE } from '../../queues/SQS/MigrationQueue';
import { logger } from '../../utils/logger';
import { PermanentMigrationError } from '../PermanentMigrationError';
import { planMigration } from '../planMigration';
import type {
  Migration,
  MigrationSource,
  QueuedRecord,
  RecordQueue,
  SourceRecord,
  StateSummary,
  TrackingRepository,
} from '../types';

/** How many planned changes a dry run returns in full; the counts always cover every record. */
export const DRY_RUN_PREVIEW_LIMIT = 50;

export const orchestratorRequestSchema = z.strictObject({
  /** Defaults to true, so a run never writes unless asked to. */
  dryRun: z.boolean().default(true),
  /** Caps how many records are selected, for a small first run. */
  limit: z.number().int().positive().optional(),
  /** Targets specific records instead of scanning for pending ones. */
  recordIds: z.array(z.string().min(1)).min(1).optional(),
  /** Migration-specific filter, validated by the migration's own schema. */
  filter: z.unknown().optional(),
});

export interface RecordIssue {
  readonly recordId: string;
  readonly reason: string;
}

export interface PlannedChange {
  readonly recordId: string;
  readonly useCase: string;
  readonly before: StateSummary;
  readonly after: StateSummary;
}

export interface OrchestratorResult {
  readonly migrationId: string;
  readonly dryRun: boolean;
  /** Records selected for migration, including ones that can't be migrated. */
  selected: number;
  /** Records sent to the queue (always 0 in a dry run). */
  queued: number;
  /** Dry run only: how many records each use case would migrate. */
  readonly byUseCase: Record<string, number>;
  /** Records that can't be migrated. A live run tracks them as failed straight away. */
  readonly failed: RecordIssue[];
  /** Requested records that were left alone (already migrated or not found). */
  readonly skipped: RecordIssue[];
  /** Dry run only: the first planned changes, before and after. */
  readonly preview: PlannedChange[];
}

export interface OrchestratorDependencies<TOld, TNew, TFilter> {
  readonly migration: Migration<TOld, TNew, TFilter>;
  readonly tracking: TrackingRepository;
  readonly queue: RecordQueue;
}

/**
 * Selects the records to migrate and enqueues one message per record. In a dry run it plans every
 * record instead and reports what would change, without writing anything.
 */
export async function orchestrate<TOld, TNew, TFilter>(
  { migration, tracking, queue }: OrchestratorDependencies<TOld, TNew, TFilter>,
  input: unknown,
): Promise<OrchestratorResult> {
  const request = orchestratorRequestSchema.parse(input ?? {});
  const filter = migration.filterSchema.parse(request.filter ?? {});
  const result: OrchestratorResult = {
    migrationId: migration.id,
    dryRun: request.dryRun,
    selected: 0,
    queued: 0,
    byUseCase: {},
    failed: [],
    skipped: [],
    preview: [],
  };
  logger.info('Orchestration started', { migrationId: migration.id, request });

  const batch: QueuedRecord[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    // Track first, so a record is never in the queue without a tracking row.
    await tracking.markQueued(migration.id, batch);
    await queue.send(batch.map(({ recordId }) => ({ migrationId: migration.id, recordId })));
    result.queued += batch.length;
    batch.length = 0;
  };

  const candidates = request.recordIds
    ? loadEach(migration.source, request.recordIds)
    : migration.source.findPending(filter);

  for await (const candidate of candidates) {
    if (request.limit !== undefined && result.selected >= request.limit) break;

    switch (candidate.status) {
      case 'missing':
        result.skipped.push({ recordId: candidate.recordId, reason: 'Record not found' });
        break;
      case 'migrated':
        result.skipped.push({ recordId: candidate.recordId, reason: 'Already migrated' });
        break;
      case 'invalid':
        result.selected++;
        result.failed.push({ recordId: candidate.recordId, reason: candidate.reason });
        if (!request.dryRun) {
          await tracking.markFailed({
            migrationId: migration.id,
            recordId: candidate.recordId,
            reason: candidate.reason,
          });
        }
        break;
      case 'pending':
        result.selected++;
        if (request.dryRun) {
          planDryRun(migration, candidate.recordId, candidate.record, result);
        } else {
          batch.push({ recordId: candidate.recordId, before: migration.summarizeOld(candidate.record) });
          if (batch.length === SQS_MAX_BATCH_SIZE) await flush();
        }
        break;
    }
  }
  await flush();

  logger.info('Orchestration finished', {
    migrationId: migration.id,
    dryRun: result.dryRun,
    selected: result.selected,
    queued: result.queued,
    failed: result.failed.length,
    skipped: result.skipped.length,
  });
  return result;
}

function planDryRun<TOld, TNew, TFilter>(
  migration: Migration<TOld, TNew, TFilter>,
  recordId: string,
  record: TOld,
  result: OrchestratorResult,
): void {
  try {
    const { useCase, before, after } = planMigration(migration, recordId, record);
    result.byUseCase[useCase] = (result.byUseCase[useCase] ?? 0) + 1;
    if (result.preview.length < DRY_RUN_PREVIEW_LIMIT) result.preview.push({ recordId, useCase, before, after });
  } catch (error) {
    if (!(error instanceof PermanentMigrationError)) throw error;
    result.failed.push({ recordId, reason: error.message });
  }
}

async function* loadEach<TOld, TNew, TFilter>(
  source: MigrationSource<TOld, TNew, TFilter>,
  recordIds: readonly string[],
): AsyncGenerator<SourceRecord<TOld, TNew>> {
  for (const recordId of new Set(recordIds)) yield await source.load(recordId);
}
