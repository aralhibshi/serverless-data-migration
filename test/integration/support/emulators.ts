import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { CreateTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  type Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { chunk } from '../../../src/utils/chunk';

/** Endpoints of the local emulators started by `npm run emulators:up` (docker-compose.yml). */
export const endpoints = {
  dynamodb: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  sqs: process.env.SQS_ENDPOINT ?? 'http://localhost:9324',
};

export const region = 'us-east-1';
const config = { region, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } };

export function createClients() {
  const dynamodb = new DynamoDBClient({ ...config, endpoint: endpoints.dynamodb });
  return {
    db: DynamoDBDocumentClient.from(dynamodb, { marshallOptions: { removeUndefinedValues: true } }),
    sqs: new SQSClient({ ...config, endpoint: endpoints.sqs }),
  };
}

/**
 * `docker compose up --wait` returns once the containers run, which can be before they accept requests.
 * Polls both emulators until they answer, so the first test doesn't fail on a cold start.
 */
export async function waitForEmulators(timeoutMs = 30_000): Promise<void> {
  const { db, sqs } = createClients();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await Promise.all([db.send(new ListTablesCommand({})), sqs.send(new ListQueuesCommand({}))]);
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error('The emulators are not reachable. Start them with `npm run emulators:up`.', { cause: error });
      }
      await sleep(500);
    }
  }
}

/** Creates fresh tables with unique names, mirroring the ones in serverless.yml. */
export async function createTables(db: DynamoDBDocumentClient) {
  const suffix = randomUUID();
  const subscribersTable = `subscribers-${suffix}`;
  const trackingTable = `migration-tracking-${suffix}`;

  await db.send(
    new CreateTableCommand({
      TableName: subscribersTable,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'subscriberId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'subscriberId', KeyType: 'HASH' }],
    }),
  );
  await db.send(
    new CreateTableCommand({
      TableName: trackingTable,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'migrationId', AttributeType: 'S' },
        { AttributeName: 'recordId', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'migrationId', KeyType: 'HASH' },
        { AttributeName: 'recordId', KeyType: 'RANGE' },
      ],
    }),
  );
  return { subscribersTable, trackingTable };
}

/** Creates a queue with a dead-letter queue, mirroring the ones in serverless.yml. */
export async function createQueues(sqs: SQSClient, maxReceiveCount: number) {
  const suffix = randomUUID();
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `migration-dlq-${suffix}` }));
  const dlqUrl = required(dlq.QueueUrl);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );

  const queue = await sqs.send(
    new CreateQueueCommand({
      QueueName: `migration-${suffix}`,
      Attributes: {
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: required(Attributes?.QueueArn), maxReceiveCount }),
      },
    }),
  );
  return { queueUrl: required(queue.QueueUrl), dlqUrl };
}

export async function putItems(db: DynamoDBDocumentClient, tableName: string, items: Record<string, unknown>[]) {
  for (const batch of chunk(items, 25)) {
    await db.send(
      new BatchWriteCommand({ RequestItems: { [tableName]: batch.map((Item) => ({ PutRequest: { Item } })) } }),
    );
  }
}

/**
 * Receives up to 10 messages. A zero visibility timeout makes unacknowledged messages visible again
 * straight away, so retries (and redrive to the dead-letter queue) happen without waiting.
 */
export async function receive(sqs: SQSClient, queueUrl: string, visibilityTimeout = 30): Promise<Message[]> {
  const { Messages } = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
      VisibilityTimeout: visibilityTimeout,
    }),
  );
  return Messages ?? [];
}

export function toQueueRecords(messages: Message[]) {
  return messages.map((message) => ({ messageId: required(message.MessageId), body: required(message.Body) }));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Expected a value from the emulator');
  return value;
}
