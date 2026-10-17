import { DeleteMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordDeadLetters } from '../../src/migration/failureHandler/recordFailures';
import { orchestrate } from '../../src/migration/orchestrator/orchestrate';
import { processBatch } from '../../src/migration/processor/processRecords';
import { buildReport } from '../../src/migration/report/buildReport';
import { MigrationQueue } from '../../src/queues/SQS/MigrationQueue';
import { MigrationTrackingRepository } from '../../src/repositories/DDB/MigrationTrackingRepository';
import { SubscriberRepository } from '../../src/repositories/DDB/SubscriberRepository';
import { createSubscriberMigration, SUBSCRIBER_MIGRATION_ID } from '../../src/subscriberMigration/subscriberMigration';
import { legacySubscriber } from '../support/subscribers';
import { createClients, createQueues, createTables, putItems, receive, toQueueRecords } from './support/emulators';

const { db, sqs } = createClients();
const MAX_RECEIVE_COUNT = 3;

const subscribers = [
  legacySubscriber({ subscriberId: 's1', status: 'active', boxSize: 'small' }),
  legacySubscriber({ subscriberId: 's2', status: 'paused', boxSize: 'medium', pausedUntil: '2026-02-01' }),
  legacySubscriber({ subscriberId: 's3', status: 'cancelled', boxSize: 'large' }),
  legacySubscriber({ subscriberId: 's4', status: 'paused' }), // no end date: fails permanently
  { subscriberId: 's5', schemaVersion: 1, boxSize: 'huge', status: 'active' }, // invalid data
];

let context: Awaited<ReturnType<typeof setup>>;

async function setup() {
  const { subscribersTable, trackingTable } = await createTables(db);
  const { queueUrl, dlqUrl } = await createQueues(sqs, MAX_RECEIVE_COUNT);
  const source = new SubscriberRepository(db, subscribersTable);
  const tracking = new MigrationTrackingRepository(db, trackingTable);
  const migration = createSubscriberMigration(source);
  return {
    subscribersTable,
    source,
    tracking,
    migration,
    queueUrl,
    dlqUrl,
    orchestrator: { migration, tracking, queue: new MigrationQueue(sqs, queueUrl) },
  };
}

/** Plays the part of the Lambda event source mapping: deletes processed messages, leaves failed ones. */
async function drain(
  queueUrl: string,
  handle: (records: ReturnType<typeof toQueueRecords>) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>,
  visibilityTimeout = 30,
) {
  for (
    let messages = await receive(sqs, queueUrl, visibilityTimeout);
    messages.length > 0;
    messages = await receive(sqs, queueUrl, visibilityTimeout)
  ) {
    const { batchItemFailures } = await handle(toQueueRecords(messages));
    const failed = new Set(batchItemFailures.map((failure) => failure.itemIdentifier));
    const done = messages.filter((message) => !failed.has(message.MessageId ?? ''));
    if (done.length > 0) {
      await sqs.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: done.map((message, index) => ({ Id: String(index), ReceiptHandle: message.ReceiptHandle })),
        }),
      );
    }
  }
}

async function getSubscriber(db: DynamoDBDocumentClient, tableName: string, subscriberId: string) {
  const { Item } = await db.send(new GetCommand({ TableName: tableName, Key: { subscriberId }, ConsistentRead: true }));
  return Item;
}

beforeEach(async () => {
  context = await setup();
  await putItems(db, context.subscribersTable, subscribers);
});

describe('migration pipeline (DynamoDB Local + ElasticMQ)', () => {
  it('dry run reports what would change and writes nothing', async () => {
    const result = await orchestrate(context.orchestrator, { dryRun: true });

    expect(result).toMatchObject({
      selected: 5,
      queued: 0,
      byUseCase: { 'active-subscriber': 1, 'paused-subscriber': 1, 'cancelled-subscriber': 1 },
    });
    expect(result.failed.map((issue) => issue.recordId).sort()).toEqual(['s4', 's5']);
    expect(await receive(sqs, context.queueUrl)).toEqual([]);
    expect(await context.tracking.list(SUBSCRIBER_MIGRATION_ID)).toEqual([]);
    expect(await getSubscriber(db, context.subscribersTable, 's1')).toEqual(subscribers[0]);
  });

  it('selects only records matching the migration filter', async () => {
    const result = await orchestrate(context.orchestrator, { filter: { boxSizes: ['small', 'large'] } });

    expect(result.selected).toBe(2);
    expect(result.byUseCase).toEqual({ 'active-subscriber': 1, 'cancelled-subscriber': 1 });
  });

  it('migrates every record, tracks every outcome, and resumes with only what has not succeeded', async () => {
    const run = await orchestrate(context.orchestrator, { dryRun: false });
    expect(run).toMatchObject({ selected: 5, queued: 4 });

    await drain(context.queueUrl, (records) => processBatch(context, records));

    expect(await getSubscriber(db, context.subscribersTable, 's2')).toEqual({
      subscriberId: 's2',
      schemaVersion: 2,
      status: 'paused',
      plan: { mealsPerWeek: 5 },
      pause: { resumesOn: '2026-02-01' },
      migratedFrom: { boxSize: 'medium' },
    });
    expect((await getSubscriber(db, context.subscribersTable, 's4'))?.schemaVersion).toBe(1);

    const report = buildReport(SUBSCRIBER_MIGRATION_ID, await context.tracking.list(SUBSCRIBER_MIGRATION_ID));
    expect(report.summary).toEqual({ total: 5, queued: 0, succeeded: 3, failed: 2 });
    expect(report.csv).toContain(
      's2,succeeded,paused-subscriber,until 2026-02-01,medium box,paused,until 2026-02-01,5 meals/week,paused',
    );
    expect(report.csv).toContain('s4,failed,,none,medium box,paused,,,,Paused subscriber has no pausedUntil date');

    // Re-running picks up only the records that haven't been migrated.
    const rerun = await orchestrate(context.orchestrator, { dryRun: false });
    expect(rerun).toMatchObject({ selected: 2, queued: 1 });
  });

  it('is idempotent when a message is delivered more than once', async () => {
    const message = { messageId: 'm1', body: JSON.stringify({ migrationId: SUBSCRIBER_MIGRATION_ID, recordId: 's1' }) };

    await processBatch(context, [message]);
    const afterFirst = await getSubscriber(db, context.subscribersTable, 's1');
    const response = await processBatch(context, [message]);

    expect(response.batchItemFailures).toEqual([]);
    expect(await getSubscriber(db, context.subscribersTable, 's1')).toEqual(afterFirst);
    expect((await context.tracking.get(SUBSCRIBER_MIGRATION_ID, 's1'))?.status).toBe('succeeded');
  });

  it('never overwrites a change made by live traffic during the migration', async () => {
    const stale = legacySubscriber({ subscriberId: 's1', status: 'active', boxSize: 'small' });
    await putItems(db, context.subscribersTable, [{ ...stale, status: 'paused', pausedUntil: '2026-05-01' }]);
    const next = context.migration.useCases[0]?.migrate(stale);
    if (next === undefined) throw new Error('Expected the active-subscriber use case');

    await expect(context.source.save(stale, next)).rejects.toThrow('Subscriber changed during migration');
    expect(await getSubscriber(db, context.subscribersTable, 's1')).toMatchObject({
      schemaVersion: 1,
      status: 'paused',
    });
  });

  it('dead-letters a record whose retries run out, and tracks it as failed with the reason', async () => {
    await orchestrate(context.orchestrator, { dryRun: false, recordIds: ['s1'] });
    const failingSource = {
      findPending: context.source.findPending.bind(context.source),
      load: context.source.load.bind(context.source),
      save: () => Promise.reject(new Error('Simulated outage')),
    };
    const failingProcessor = { tracking: context.tracking, migration: { ...context.migration, source: failingSource } };

    // Every attempt fails; ElasticMQ moves the message to the dead-letter queue after MAX_RECEIVE_COUNT receives.
    await drain(context.queueUrl, (records) => processBatch(failingProcessor, records), 0);
    await drain(context.dlqUrl, (records) => recordDeadLetters(context.tracking, records));

    expect(await context.tracking.get(SUBSCRIBER_MIGRATION_ID, 's1')).toMatchObject({
      status: 'failed',
      attempts: MAX_RECEIVE_COUNT,
      reason: `Retries exhausted (${String(MAX_RECEIVE_COUNT)} failed attempts). Last error: Error: Simulated outage`,
    });
    expect((await getSubscriber(db, context.subscribersTable, 's1'))?.schemaVersion).toBe(1);
  });
});

describe('MigrationTrackingRepository', () => {
  it('writes queued rows in batches and lists them all', async () => {
    const records = Array.from({ length: 60 }, (_, index) => ({
      recordId: `r${String(index).padStart(2, '0')}`,
      before: {},
    }));

    await context.tracking.markQueued('m', records);

    const entries = await context.tracking.list('m');
    expect(entries).toHaveLength(60);
    expect(entries.every((entry) => entry.status === 'queued' && entry.attempts === 0)).toBe(true);
  });

  it('never marks a succeeded record as failed', async () => {
    await context.tracking.markSucceeded({ migrationId: 'm', recordId: 'r1', after: { plan: 'x' } });
    await context.tracking.markFailed({ migrationId: 'm', recordId: 'r1', reason: 'late failure' });

    expect(await context.tracking.get('m', 'r1')).toMatchObject({ status: 'succeeded', after: { plan: 'x' } });
  });

  it('clears an earlier failure reason when a record later succeeds', async () => {
    await context.tracking.markFailed({ migrationId: 'm', recordId: 'r1', reason: 'first try' });
    await context.tracking.markSucceeded({ migrationId: 'm', recordId: 'r1', after: {} });

    const entry = await context.tracking.get('m', 'r1');
    expect(entry?.status).toBe('succeeded');
    expect(entry?.reason).toBeUndefined();
  });
});
