import type { SQSBatchResponse } from 'aws-lambda';

import { errorMessage } from '../../utils/errorMessage';
import { logger } from '../../utils/logger';
import { type MigrationMessage, parseMigrationMessage, type QueueRecord } from '../migrationMessage';
import { PermanentMigrationError } from '../PermanentMigrationError';
import { planMigration } from '../planMigration';
import type { Migration, TrackingRepository } from '../types';

export type ProcessOutcome = 'migrated' | 'already-migrated' | 'failed';

export interface ProcessorDependencies<TOld, TNew, TFilter> {
  readonly migration: Migration<TOld, TNew, TFilter>;
  readonly tracking: TrackingRepository;
}

/**
 * Migrates one record. Idempotent: a record that has already been migrated is a no-op that is tracked
 * as a success. Permanent failures are tracked and acknowledged; anything else is rethrown to be retried.
 */
export async function processRecord<TOld, TNew, TFilter>(
  { migration, tracking }: ProcessorDependencies<TOld, TNew, TFilter>,
  { migrationId, recordId }: MigrationMessage,
): Promise<ProcessOutcome> {
  try {
    const loaded = await migration.source.load(recordId);
    switch (loaded.status) {
      case 'missing':
        throw new PermanentMigrationError('Record not found');
      case 'invalid':
        throw new PermanentMigrationError(loaded.reason);
      case 'migrated':
        await tracking.markSucceeded({ migrationId, recordId, after: migration.summarizeNew(loaded.record) });
        return 'already-migrated';
      case 'pending': {
        const plan = planMigration(migration, recordId, loaded.record);
        const saved = await migration.source.save(loaded.record, plan.next);
        await tracking.markSucceeded({
          migrationId,
          recordId,
          useCase: plan.useCase,
          before: plan.before,
          after: plan.after,
        });
        return saved === 'saved' ? 'migrated' : 'already-migrated';
      }
    }
  } catch (error) {
    if (error instanceof PermanentMigrationError) {
      await tracking.markFailed({ migrationId, recordId, reason: error.message });
      return 'failed';
    }
    // Best effort: keep the error so the failure handler can explain it if retries run out.
    await tracking.recordAttemptError(migrationId, recordId, errorMessage(error)).catch((trackingError: unknown) => {
      logger.warn('Could not record attempt error', { migrationId, recordId, error: errorMessage(trackingError) });
    });
    throw error;
  }
}

/**
 * Processes an SQS batch and reports partial batch failures, so only the failed messages are retried.
 * Records run one at a time: throughput is set by the event source's maximum concurrency.
 */
export async function processBatch<TOld, TNew, TFilter>(
  dependencies: ProcessorDependencies<TOld, TNew, TFilter>,
  records: readonly QueueRecord[],
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const { messageId, body } of records) {
    try {
      const message = parseMigrationMessage(body);
      if (message.migrationId !== dependencies.migration.id) {
        throw new Error(`Message is for migration "${message.migrationId}", not "${dependencies.migration.id}"`);
      }
      const outcome = await processRecord(dependencies, message);
      logger.info('Record processed', { messageId, ...message, outcome });
    } catch (error) {
      logger.error('Record will be retried', { messageId, error: errorMessage(error) });
      batchItemFailures.push({ itemIdentifier: messageId });
    }
  }

  return { batchItemFailures };
}
