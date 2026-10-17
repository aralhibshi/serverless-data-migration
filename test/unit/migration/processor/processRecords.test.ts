import { describe, expect, it } from 'vitest';

import { processBatch, processRecord } from '../../../../src/migration/processor/processRecords';
import {
  createSubscriberMigration,
  SUBSCRIBER_MIGRATION_ID,
} from '../../../../src/subscriberMigration/subscriberMigration';
import { InMemorySubscriberRepository } from '../../../support/InMemorySubscriberRepository';
import { InMemoryTrackingRepository } from '../../../support/InMemoryTrackingRepository';
import { legacySubscriber } from '../../../support/subscribers';

const migrationId = SUBSCRIBER_MIGRATION_ID;

function setup(items: Record<string, unknown>[]) {
  const source = new InMemorySubscriberRepository(items);
  const tracking = new InMemoryTrackingRepository();
  return { source, tracking, dependencies: { migration: createSubscriberMigration(source), tracking } };
}

describe('processRecord', () => {
  it('migrates a record and tracks the success with its before and after state', async () => {
    const { source, tracking, dependencies } = setup([
      legacySubscriber({ subscriberId: 's1', status: 'paused', boxSize: 'large', pausedUntil: '2026-03-01' }),
    ]);

    expect(await processRecord(dependencies, { migrationId, recordId: 's1' })).toBe('migrated');

    expect(source.items.get('s1')).toEqual({
      subscriberId: 's1',
      schemaVersion: 2,
      status: 'paused',
      plan: { mealsPerWeek: 8 },
      pause: { resumesOn: '2026-03-01' },
      migratedFrom: { boxSize: 'large' },
    });
    expect(await tracking.get(migrationId, 's1')).toMatchObject({
      status: 'succeeded',
      useCase: 'paused-subscriber',
      before: { plan: 'large box', status: 'paused', pause: 'until 2026-03-01' },
      after: { plan: '8 meals/week', status: 'paused', pause: 'until 2026-03-01' },
    });
  });

  it('is idempotent: re-processing a migrated record is a no-op tracked as a success', async () => {
    const { source, tracking, dependencies } = setup([legacySubscriber({ subscriberId: 's1' })]);
    await processRecord(dependencies, { migrationId, recordId: 's1' });
    const migrated = structuredClone(source.items.get('s1'));

    expect(await processRecord(dependencies, { migrationId, recordId: 's1' })).toBe('already-migrated');

    expect(source.items.get('s1')).toEqual(migrated);
    expect((await tracking.get(migrationId, 's1'))?.status).toBe('succeeded');
  });

  it.each([
    ['a missing record', [], 'Record not found'],
    [
      'invalid data',
      [{ subscriberId: 's1', schemaVersion: 1, boxSize: 'huge', status: 'active' }],
      expect.stringContaining('Invalid record'),
    ],
    [
      'a record no use case can migrate',
      [legacySubscriber({ subscriberId: 's1', status: 'paused' })],
      'Paused subscriber has no pausedUntil date',
    ],
  ])('tracks %s as failed without retrying', async (_, items, reason) => {
    const { tracking, dependencies } = setup(items);

    expect(await processRecord(dependencies, { migrationId, recordId: 's1' })).toBe('failed');

    expect(await tracking.get(migrationId, 's1')).toMatchObject({ status: 'failed', reason });
  });

  it('records a transient error and rethrows it so the message is retried', async () => {
    const { source, tracking, dependencies } = setup([legacySubscriber({ subscriberId: 's1' })]);
    source.saveErrors.push(new Error('Throttled'));

    await expect(processRecord(dependencies, { migrationId, recordId: 's1' })).rejects.toThrow('Throttled');

    expect(await tracking.get(migrationId, 's1')).toMatchObject({ lastError: 'Error: Throttled', attempts: 1 });
  });

  it('still rethrows the original error when recording it fails', async () => {
    const { source, tracking, dependencies } = setup([legacySubscriber({ subscriberId: 's1' })]);
    source.saveErrors.push(new Error('Throttled'));
    tracking.recordAttemptError = () => Promise.reject(new Error('Tracking down'));

    await expect(processRecord(dependencies, { migrationId, recordId: 's1' })).rejects.toThrow('Throttled');
  });
});

describe('processBatch', () => {
  it('reports only the failed messages, so only those are retried', async () => {
    const { source, dependencies } = setup([
      legacySubscriber({ subscriberId: 's1' }),
      legacySubscriber({ subscriberId: 's2' }),
      legacySubscriber({ subscriberId: 's3', status: 'paused' }),
    ]);
    source.saveErrors.push(new Error('Throttled'));
    const body = (recordId: string) => JSON.stringify({ migrationId, recordId });

    const response = await processBatch(dependencies, [
      { messageId: 'm1', body: body('s1') }, // transient failure: retried
      { messageId: 'm2', body: body('s2') }, // migrated
      { messageId: 'm3', body: body('s3') }, // permanent failure: tracked, not retried
      { messageId: 'm4', body: 'not json' }, // malformed: retried, then dead-lettered
      { messageId: 'm5', body: JSON.stringify({ migrationId: 'other', recordId: 's2' }) },
    ]);

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: 'm1' },
      { itemIdentifier: 'm4' },
      { itemIdentifier: 'm5' },
    ]);
    expect(source.items.get('s2')?.schemaVersion).toBe(2);
  });
});
