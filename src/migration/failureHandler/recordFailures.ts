import type { SQSBatchResponse } from 'aws-lambda';

import type { MigrationTrackingEntity } from '../../entities/DDB/MigrationTrackingEntity';
import { errorMessage } from '../../utils/errorMessage';
import { logger } from '../../utils/logger';
import { type MigrationMessage, parseMigrationMessage, type QueueRecord } from '../migrationMessage';
import type { TrackingRepository } from '../types';

/** Messages that can't be parsed have no migration id, so they're tracked under this one instead. */
export const UNPARSEABLE_MIGRATION_ID = 'unparseable-messages';
const MAX_REASON_LENGTH = 1000;

/** Explains why a record ended up in the dead-letter queue, falling back when no error was recorded. */
export function deadLetterReason(entry: MigrationTrackingEntity | undefined): string {
  if (entry === undefined) return 'Retries exhausted; the record was never tracked and no error was recorded';
  const attempts = `${String(entry.attempts)} failed attempt${entry.attempts === 1 ? '' : 's'}`;
  if (entry.lastError) return `Retries exhausted (${attempts}). Last error: ${entry.lastError}`;
  return `Retries exhausted (${attempts}) with no error recorded`;
}

/** Records a dead-lettered message as a failure, so no failure is silent. */
export async function recordDeadLetter(tracking: TrackingRepository, { messageId, body }: QueueRecord): Promise<void> {
  let message: MigrationMessage;
  try {
    message = parseMigrationMessage(body);
  } catch (error) {
    await tracking.markFailed({
      migrationId: UNPARSEABLE_MIGRATION_ID,
      recordId: messageId,
      reason: truncate(`Malformed message (${errorMessage(error)}). Body: ${body}`),
    });
    return;
  }

  const entry = await tracking.get(message.migrationId, message.recordId);
  if (entry?.status === 'succeeded') {
    logger.warn('Dead-lettered record had already succeeded; leaving it as a success', { messageId, ...message });
    return;
  }
  await tracking.markFailed({ ...message, reason: truncate(deadLetterReason(entry)) });
  logger.info('Dead-lettered record tracked as failed', { messageId, ...message });
}

/** Handles a batch from the dead-letter queue; a message is retried only if it couldn't be tracked. */
export async function recordDeadLetters(
  tracking: TrackingRepository,
  records: readonly QueueRecord[],
): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of records) {
    try {
      await recordDeadLetter(tracking, record);
    } catch (error) {
      logger.error('Could not track dead-lettered record', { messageId: record.messageId, error: errorMessage(error) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

function truncate(text: string): string {
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}
