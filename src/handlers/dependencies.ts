import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

import { MigrationQueue } from '../queues/SQS/MigrationQueue';
import { MigrationTrackingRepository } from '../repositories/DDB/MigrationTrackingRepository';
import { SubscriberRepository } from '../repositories/DDB/SubscriberRepository';
import { createSubscriberMigration } from '../subscriberMigration/subscriberMigration';

/** Set by serverless.yml. Validated up front, so a misconfigured function fails on cold start, not mid-run. */
const environmentSchema = z.object({
  SUBSCRIBERS_TABLE: z.string().min(1),
  TRACKING_TABLE: z.string().min(1),
  MIGRATION_QUEUE_URL: z.url(),
});

/** Built once per Lambda container, so clients and connections are reused across invocations. */
function createDependencies() {
  const environment = environmentSchema.parse(process.env);
  const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    migration: createSubscriberMigration(new SubscriberRepository(db, environment.SUBSCRIBERS_TABLE)),
    tracking: new MigrationTrackingRepository(db, environment.TRACKING_TABLE),
    queue: new MigrationQueue(new SQSClient({}), environment.MIGRATION_QUEUE_URL),
  };
}

export const dependencies = createDependencies();
