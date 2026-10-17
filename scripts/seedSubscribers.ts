/**
 * Seeds the subscribers table with old-schema records for a demo run.
 *
 *   SUBSCRIBERS_TABLE=<table> npm run seed -- 500
 *
 * About 1 in 50 subscribers is seeded as paused without an end date, so the run shows how a record
 * that can't be migrated is tracked and reported instead of failing silently.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { boxSizes, type LegacySubscriber, subscriptionStatuses } from '../src/entities/DDB/SubscriberEntity';
import { chunk } from '../src/utils/chunk';

const tableName = process.env.SUBSCRIBERS_TABLE;
const count = Number(process.argv[2] ?? 100);
if (!tableName) throw new Error('Set SUBSCRIBERS_TABLE to the table to seed');
if (!Number.isInteger(count) || count < 1) throw new Error('Pass a positive whole number of subscribers');

function pick<T>(items: readonly T[], index: number): T {
  const item = items[index % items.length];
  if (item === undefined) throw new Error('Cannot pick from an empty list');
  return item;
}

function subscriber(index: number): LegacySubscriber {
  const subscriberId = `sub-${String(index).padStart(5, '0')}`;
  const boxSize = pick(boxSizes, index * 7);
  const status = pick(subscriptionStatuses, index * 3 + (index % 5));
  if (status !== 'paused' || index % 50 === 1) return { subscriberId, schemaVersion: 1, boxSize, status };
  const pausedUntil = new Date(Date.UTC(2027, index % 12, (index % 28) + 1)).toISOString().slice(0, 10);
  return { subscriberId, schemaVersion: 1, boxSize, status, pausedUntil };
}

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const subscribers = Array.from({ length: count }, (_, index) => subscriber(index));

for (const batch of chunk(subscribers, 25)) {
  const { UnprocessedItems } = await db.send(
    new BatchWriteCommand({ RequestItems: { [tableName]: batch.map((Item) => ({ PutRequest: { Item } })) } }),
  );
  const unprocessed = UnprocessedItems?.[tableName]?.length ?? 0;
  if (unprocessed > 0) throw new Error(`${String(unprocessed)} items were not written; re-run to retry`);
}

console.info(`Seeded ${String(count)} subscribers into ${tableName}`);
