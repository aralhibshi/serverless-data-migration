import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Message } from '@aws-sdk/client-sqs';
import type { Context, SQSEvent } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { UNPARSEABLE_MIGRATION_ID } from '../../src/migration/failureHandler/recordFailures';
import { MigrationTrackingRepository } from '../../src/repositories/DDB/MigrationTrackingRepository';
import { legacySubscriber } from '../support/subscribers';
import { createClients, createQueues, createTables, endpoints, putItems, receive, region } from './support/emulators';

/*
 * Runs the real Lambda handlers (environment validation, client creation and wiring) against the emulators,
 * pointing the AWS SDK at them through its standard AWS_ENDPOINT_URL_* variables.
 */

const { db, sqs } = createClients();
let trackingTable: string;
let queueUrl: string;

beforeAll(async () => {
  const tables = await createTables(db);
  const queues = await createQueues(sqs, 3);
  trackingTable = tables.trackingTable;
  queueUrl = queues.queueUrl;
  await putItems(db, tables.subscribersTable, [
    legacySubscriber({ subscriberId: 's1', status: 'active' }),
    legacySubscriber({ subscriberId: 's2', status: 'paused', pausedUntil: '2026-02-01' }),
    legacySubscriber({ subscriberId: 's3', status: 'cancelled' }),
  ]);

  vi.stubEnv('SUBSCRIBERS_TABLE', tables.subscribersTable);
  vi.stubEnv('TRACKING_TABLE', trackingTable);
  vi.stubEnv('MIGRATION_QUEUE_URL', queueUrl);
  vi.stubEnv('AWS_REGION', region);
  vi.stubEnv('AWS_ACCESS_KEY_ID', 'local');
  vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'local');
  vi.stubEnv('AWS_ENDPOINT_URL_DYNAMODB', endpoints.dynamodb);
  vi.stubEnv('AWS_ENDPOINT_URL_SQS', endpoints.sqs);
});

afterAll(() => {
  vi.unstubAllEnvs();
});

function lambdaContext(functionName: string): Context {
  return {
    callbackWaitsForEmptyEventLoop: false,
    functionName,
    functionVersion: '$LATEST',
    invokedFunctionArn: `arn:aws:lambda:${region}:000000000000:function:${functionName}`,
    memoryLimitInMB: '512',
    awsRequestId: randomUUID(),
    logGroupName: `/aws/lambda/${functionName}`,
    logStreamName: 'local',
    getRemainingTimeInMillis: () => 30_000,
    done: () => undefined,
    fail: () => undefined,
    succeed: () => undefined,
  };
}

function sqsEvent(messages: { messageId: string; body: string }[]): SQSEvent {
  return {
    Records: messages.map(({ messageId, body }) => ({
      messageId,
      body,
      receiptHandle: messageId,
      attributes: {
        ApproximateReceiveCount: '1',
        SentTimestamp: String(Date.now()),
        SenderId: 'local',
        ApproximateFirstReceiveTimestamp: String(Date.now()),
      },
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: `arn:aws:sqs:${region}:000000000000:queue`,
      awsRegion: region,
    })),
  };
}

async function receiveAll(count: number): Promise<Message[]> {
  const messages: Message[] = [];
  while (messages.length < count) {
    const batch = await receive(sqs, queueUrl);
    if (batch.length === 0) break;
    messages.push(...batch);
  }
  return messages;
}

describe('Lambda handlers', () => {
  it('every function in serverless.yml points at a module that exports a handler', async () => {
    const paths = [...readFileSync('serverless.yml', 'utf8').matchAll(/handler: (\S+)\.handler/g)].map(
      ([, path]) => path ?? '',
    );

    expect(paths).toHaveLength(4);
    for (const path of paths) {
      const module: unknown = await import(resolve(`${path}.ts`));
      expect(module).toHaveProperty('handler', expect.any(Function));
    }
  });

  it('runs a migration end to end through the deployed entry points', async () => {
    const { handler: orchestrator } = await import('../../src/handlers/orchestrator');
    const { handler: processor } = await import('../../src/handlers/processor');
    const { handler: report } = await import('../../src/handlers/report');

    const run = await orchestrator({ dryRun: false }, lambdaContext('orchestrator'));
    expect(run.queued).toBe(3);

    const messages = await receiveAll(3);
    const response = await processor(
      sqsEvent(messages.map((message) => ({ messageId: message.MessageId ?? '', body: message.Body ?? '' }))),
      lambdaContext('processor'),
    );
    expect(response.batchItemFailures).toEqual([]);

    const { summary } = await report({}, lambdaContext('report'));
    expect(summary).toEqual({ total: 3, queued: 0, succeeded: 3, failed: 0 });
  });

  it('the failure handler tracks a dead-lettered message', async () => {
    const { handler: failureHandler } = await import('../../src/handlers/failureHandler');

    const response = await failureHandler(
      sqsEvent([{ messageId: 'dead-1', body: 'not json' }]),
      lambdaContext('failureHandler'),
    );

    expect(response.batchItemFailures).toEqual([]);
    const tracking = new MigrationTrackingRepository(db, trackingTable);
    expect((await tracking.get(UNPARSEABLE_MIGRATION_ID, 'dead-1'))?.status).toBe('failed');
  });

  it('fails on cold start when its configuration is invalid', async () => {
    vi.resetModules();
    vi.stubEnv('MIGRATION_QUEUE_URL', 'not a url');

    await expect(import('../../src/handlers/dependencies')).rejects.toThrow(/MIGRATION_QUEUE_URL/);
  });
});
