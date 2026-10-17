import { describe, expect, it } from 'vitest';

import { DRY_RUN_PREVIEW_LIMIT, orchestrate } from '../../../../src/migration/orchestrator/orchestrate';
import {
  createSubscriberMigration,
  SUBSCRIBER_MIGRATION_ID,
} from '../../../../src/subscriberMigration/subscriberMigration';
import { InMemorySubscriberRepository } from '../../../support/InMemorySubscriberRepository';
import { InMemoryTrackingRepository } from '../../../support/InMemoryTrackingRepository';
import { RecordingQueue } from '../../../support/RecordingQueue';
import { legacySubscriber } from '../../../support/subscribers';

function setup(items: Record<string, unknown>[]) {
  const source = new InMemorySubscriberRepository(items);
  const tracking = new InMemoryTrackingRepository();
  const queue = new RecordingQueue();
  const dependencies = { migration: createSubscriberMigration(source), tracking, queue };
  return { source, tracking, queue, dependencies };
}

const mixed = [
  legacySubscriber({ subscriberId: 's1', status: 'active', boxSize: 'small' }),
  legacySubscriber({ subscriberId: 's2', status: 'paused', pausedUntil: '2026-02-01' }),
  legacySubscriber({ subscriberId: 's3', status: 'cancelled', boxSize: 'large' }),
  legacySubscriber({ subscriberId: 's4', status: 'paused' }), // no pausedUntil: can't be migrated
  { subscriberId: 's5', schemaVersion: 1, boxSize: 'huge', status: 'active' }, // invalid data
];

describe('orchestrate: dry run', () => {
  it('is the default, and reports what would change without writing anything', async () => {
    const { tracking, queue, source, dependencies } = setup(mixed);
    const before = structuredClone([...source.items]);

    const result = await orchestrate(dependencies, {});

    expect(result.dryRun).toBe(true);
    expect(result.selected).toBe(5);
    expect(result.queued).toBe(0);
    expect(result.byUseCase).toEqual({ 'active-subscriber': 1, 'paused-subscriber': 1, 'cancelled-subscriber': 1 });
    expect(result.failed).toEqual([
      { recordId: 's4', reason: 'Paused subscriber has no pausedUntil date' },
      { recordId: 's5', reason: expect.stringContaining('Invalid record') },
    ]);
    expect(result.preview[0]).toEqual({
      recordId: 's1',
      useCase: 'active-subscriber',
      before: { plan: 'small box', status: 'active', pause: 'none' },
      after: { plan: '3 meals/week', status: 'active', pause: 'none' },
    });
    expect(queue.messages).toEqual([]);
    expect(tracking.entries.size).toBe(0);
    expect([...source.items]).toEqual(before);
  });

  it('counts every record but caps the preview', async () => {
    const items = Array.from({ length: DRY_RUN_PREVIEW_LIMIT + 5 }, (_, index) =>
      legacySubscriber({ subscriberId: `s${String(index)}` }),
    );
    const { dependencies } = setup(items);

    const result = await orchestrate(dependencies, { dryRun: true });

    expect(result.byUseCase).toEqual({ 'active-subscriber': DRY_RUN_PREVIEW_LIMIT + 5 });
    expect(result.preview).toHaveLength(DRY_RUN_PREVIEW_LIMIT);
  });
});

describe('orchestrate: live run', () => {
  it('tracks and enqueues one message per pending record, and tracks invalid records as failed', async () => {
    const { tracking, queue, dependencies } = setup(mixed);

    const result = await orchestrate(dependencies, { dryRun: false });

    expect(result).toMatchObject({ dryRun: false, selected: 5, queued: 4 });
    expect(queue.messages.map((message) => message.recordId)).toEqual(['s1', 's2', 's3', 's4']);
    expect(queue.messages.every((message) => message.migrationId === SUBSCRIBER_MIGRATION_ID)).toBe(true);
    expect(await tracking.get(SUBSCRIBER_MIGRATION_ID, 's1')).toMatchObject({
      status: 'queued',
      before: { plan: 'small box', status: 'active', pause: 'none' },
    });
    expect((await tracking.get(SUBSCRIBER_MIGRATION_ID, 's5'))?.status).toBe('failed');
  });

  it('enqueues in batches of 10, tracking each batch before sending it', async () => {
    const items = Array.from({ length: 23 }, (_, index) => legacySubscriber({ subscriberId: `s${String(index)}` }));
    const { tracking, queue, dependencies } = setup(items);

    await orchestrate(dependencies, { dryRun: false });

    expect(queue.batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(tracking.calls).toEqual(['markQueued:10', 'markQueued:10', 'markQueued:3']);
  });

  it('respects the limit', async () => {
    const { queue, dependencies } = setup(mixed);

    const result = await orchestrate(dependencies, { dryRun: false, limit: 2 });

    expect(result.selected).toBe(2);
    expect(queue.messages).toHaveLength(2);
  });

  it('applies the migration filter', async () => {
    const { queue, dependencies } = setup(mixed);

    await orchestrate(dependencies, { dryRun: false, filter: { boxSizes: ['small', 'large'] } });

    expect(queue.messages.map((message) => message.recordId)).toEqual(['s1', 's3']);
  });

  it('targets specific records, skipping ones that are missing or already migrated', async () => {
    const migrated = {
      subscriberId: 's9',
      schemaVersion: 2,
      status: 'active',
      plan: { mealsPerWeek: 5 },
      pause: null,
      migratedFrom: { boxSize: 'medium' },
    };
    const { queue, dependencies } = setup([...mixed, migrated]);

    const result = await orchestrate(dependencies, { dryRun: false, recordIds: ['s1', 's1', 's9', 'nope'] });

    expect(queue.messages.map((message) => message.recordId)).toEqual(['s1']);
    expect(result.skipped).toEqual([
      { recordId: 's9', reason: 'Already migrated' },
      { recordId: 'nope', reason: 'Record not found' },
    ]);
  });

  it('picks up only what has not been migrated when re-run', async () => {
    const { source, queue, dependencies } = setup(mixed);
    source.items.set('s1', {
      subscriberId: 's1',
      schemaVersion: 2,
      status: 'active',
      plan: { mealsPerWeek: 3 },
      pause: null,
      migratedFrom: { boxSize: 'small' },
    });

    await orchestrate(dependencies, { dryRun: false });

    expect(queue.messages.map((message) => message.recordId)).toEqual(['s2', 's3', 's4']);
  });
});

describe('orchestrate: request validation', () => {
  it('rejects unknown fields, so a typo cannot silently change a run', async () => {
    const { dependencies } = setup(mixed);
    await expect(orchestrate(dependencies, { dryrun: false })).rejects.toThrow();
  });

  it('rejects an invalid migration filter', async () => {
    const { dependencies } = setup(mixed);
    await expect(orchestrate(dependencies, { filter: { boxSizes: ['huge'] } })).rejects.toThrow();
  });
});
