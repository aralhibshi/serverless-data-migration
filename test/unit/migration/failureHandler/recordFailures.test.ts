import { describe, expect, it } from 'vitest';

import type { MigrationTrackingEntity } from '../../../../src/entities/DDB/MigrationTrackingEntity';
import {
  deadLetterReason,
  recordDeadLetters,
  UNPARSEABLE_MIGRATION_ID,
} from '../../../../src/migration/failureHandler/recordFailures';
import { InMemoryTrackingRepository, NOW } from '../../../support/InMemoryTrackingRepository';

const entry = (overrides: Partial<MigrationTrackingEntity>): MigrationTrackingEntity => ({
  migrationId: 'm',
  recordId: 'r1',
  status: 'queued',
  attempts: 3,
  updatedAt: NOW,
  ...overrides,
});

describe('deadLetterReason', () => {
  it('uses the last recorded error', () => {
    expect(deadLetterReason(entry({ lastError: 'Error: timeout' }))).toBe(
      'Retries exhausted (3 failed attempts). Last error: Error: timeout',
    );
  });

  it('falls back when no error was recorded', () => {
    expect(deadLetterReason(entry({ attempts: 1 }))).toBe(
      'Retries exhausted (1 failed attempt) with no error recorded',
    );
  });

  it('falls back when the record was never tracked', () => {
    expect(deadLetterReason(undefined)).toBe(
      'Retries exhausted; the record was never tracked and no error was recorded',
    );
  });
});

describe('recordDeadLetters', () => {
  it('marks each dead-lettered record as failed with its reason', async () => {
    const tracking = new InMemoryTrackingRepository();
    await tracking.recordAttemptError('m', 'r1', 'Error: throttled');

    const response = await recordDeadLetters(tracking, [
      { messageId: 'msg-1', body: JSON.stringify({ migrationId: 'm', recordId: 'r1' }) },
    ]);

    expect(response.batchItemFailures).toEqual([]);
    expect(await tracking.get('m', 'r1')).toMatchObject({
      status: 'failed',
      reason: 'Retries exhausted (1 failed attempt). Last error: Error: throttled',
    });
  });

  it('tracks a malformed message under its message id, so it is not lost', async () => {
    const tracking = new InMemoryTrackingRepository();

    await recordDeadLetters(tracking, [{ messageId: 'msg-1', body: 'not json' }]);

    const failure = await tracking.get(UNPARSEABLE_MIGRATION_ID, 'msg-1');
    expect(failure?.status).toBe('failed');
    expect(failure?.reason).toMatch(/^Malformed message \(Error: Message body is not valid JSON\)\. Body: not json$/);
  });

  it('leaves a record that already succeeded as a success', async () => {
    const tracking = new InMemoryTrackingRepository();
    await tracking.markSucceeded({ migrationId: 'm', recordId: 'r1', after: {} });

    await recordDeadLetters(tracking, [
      { messageId: 'msg-1', body: JSON.stringify({ migrationId: 'm', recordId: 'r1' }) },
    ]);

    expect((await tracking.get('m', 'r1'))?.status).toBe('succeeded');
  });

  it('retries only the messages it could not track', async () => {
    const tracking = new InMemoryTrackingRepository();
    tracking.markFailed = () => Promise.reject(new Error('DynamoDB unavailable'));

    const response = await recordDeadLetters(tracking, [{ messageId: 'msg-1', body: 'not json' }]);

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: 'msg-1' }]);
  });
});
