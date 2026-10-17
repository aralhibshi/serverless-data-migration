import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { type DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import {
  type MigrationTrackingEntity,
  migrationTrackingEntitySchema,
} from '../../entities/DDB/MigrationTrackingEntity';
import type { FailedRecord, QueuedRecord, SucceededRecord, TrackingRepository } from '../../migration/types';
import { logger } from '../../utils/logger';
import { DynamoDBRepository } from './DynamoDBRepository';

export class MigrationTrackingRepository
  extends DynamoDBRepository<MigrationTrackingEntity>
  implements TrackingRepository
{
  constructor(
    db: DynamoDBDocumentClient,
    tableName: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    super(db, tableName);
  }

  protected toEntity(item: Record<string, unknown>): MigrationTrackingEntity {
    return migrationTrackingEntitySchema.parse(item);
  }

  async markQueued(migrationId: string, records: readonly QueuedRecord[]): Promise<void> {
    const updatedAt = this.now();
    await this.batchPut(
      records.map(({ recordId, before }): MigrationTrackingEntity => ({
        migrationId,
        recordId,
        status: 'queued',
        before,
        attempts: 0,
        updatedAt,
      })),
    );
  }

  async markSucceeded({ migrationId, recordId, useCase, before, after }: SucceededRecord): Promise<void> {
    const sets = [
      '#status = :succeeded',
      '#after = :after',
      'updatedAt = :now',
      'attempts = if_not_exists(attempts, :zero)',
    ];
    const values: Record<string, unknown> = {
      ':succeeded': 'succeeded',
      ':after': after,
      ':now': this.now(),
      ':zero': 0,
    };
    const names: Record<string, string> = { '#status': 'status', '#after': 'after' };
    if (useCase !== undefined) {
      sets.push('useCase = :useCase');
      values[':useCase'] = useCase;
    }
    if (before !== undefined) {
      sets.push('#before = :before');
      values[':before'] = before;
      names['#before'] = 'before';
    }

    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { migrationId, recordId },
        UpdateExpression: `SET ${sets.join(', ')} REMOVE reason`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  }

  async markFailed({ migrationId, recordId, reason }: FailedRecord): Promise<void> {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { migrationId, recordId },
          UpdateExpression:
            'SET #status = :failed, reason = :reason, updatedAt = :now, attempts = if_not_exists(attempts, :zero)',
          ConditionExpression: 'attribute_not_exists(#status) OR #status <> :succeeded',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: {
            ':failed': 'failed',
            ':succeeded': 'succeeded',
            ':reason': reason,
            ':now': this.now(),
            ':zero': 0,
          },
        }),
      );
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      logger.warn('Not marking a succeeded record as failed', { migrationId, recordId, reason });
    }
  }

  async recordAttemptError(migrationId: string, recordId: string, error: string): Promise<void> {
    await this.db.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { migrationId, recordId },
        UpdateExpression:
          'SET lastError = :error, updatedAt = :now, #status = if_not_exists(#status, :queued) ADD attempts :one',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':error': error, ':now': this.now(), ':queued': 'queued', ':one': 1 },
      }),
    );
  }

  get(migrationId: string, recordId: string): Promise<MigrationTrackingEntity | undefined> {
    return this.getItem({ migrationId, recordId });
  }

  async list(migrationId: string): Promise<MigrationTrackingEntity[]> {
    const entities: MigrationTrackingEntity[] = [];
    const pages = this.paginate((startKey) =>
      this.db.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'migrationId = :migrationId',
          ExpressionAttributeValues: { ':migrationId': migrationId },
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
        }),
      ),
    );
    for await (const entity of pages) entities.push(entity);
    return entities;
  }
}
