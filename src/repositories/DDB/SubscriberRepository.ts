import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import {
  type LegacySubscriber,
  type Subscriber,
  type SubscriberEntity,
  type SubscriberFilter,
  toSubscriberEntity,
} from '../../entities/DDB/SubscriberEntity';
import type { MigrationSource, SaveResult } from '../../migration/types';
import { DynamoDBRepository } from './DynamoDBRepository';

/** The subscribers table, as the migration's source. */
export class SubscriberRepository
  extends DynamoDBRepository<SubscriberEntity>
  implements MigrationSource<LegacySubscriber, Subscriber, SubscriberFilter>
{
  protected toEntity(item: Record<string, unknown>): SubscriberEntity {
    return toSubscriberEntity(item);
  }

  /**
   * Scans for records not yet on schema version 2. A scan is fine for thousands of records; for much
   * larger tables, a sparse index on unmigrated records would avoid reading the whole table.
   */
  findPending(filter: SubscriberFilter): AsyncGenerator<SubscriberEntity> {
    const conditions = ['(attribute_not_exists(schemaVersion) OR schemaVersion <> :migrated)'];
    const values: Record<string, unknown> = { ':migrated': 2 };
    if (filter.boxSizes) {
      const placeholders = filter.boxSizes.map((boxSize, index) => {
        values[`:boxSize${String(index)}`] = boxSize;
        return `:boxSize${String(index)}`;
      });
      conditions.push(`boxSize IN (${placeholders.join(', ')})`);
    }

    return this.paginate((startKey) =>
      this.db.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: conditions.join(' AND '),
          ExpressionAttributeValues: values,
          ExclusiveStartKey: startKey,
        }),
      ),
    );
  }

  async load(recordId: string): Promise<SubscriberEntity> {
    return (await this.getItem({ subscriberId: recordId })) ?? { status: 'missing', recordId };
  }

  /**
   * Optimistic concurrency: the write only succeeds if the record still has the state it was migrated
   * from, so a change from live traffic in the meantime is never overwritten.
   */
  async save(previous: LegacySubscriber, next: Subscriber): Promise<SaveResult> {
    const conditions = ['schemaVersion = :legacy', '#status = :status', 'boxSize = :boxSize'];
    const values: Record<string, unknown> = {
      ':legacy': 1,
      ':status': previous.status,
      ':boxSize': previous.boxSize,
    };
    if (previous.pausedUntil === undefined) {
      conditions.push('attribute_not_exists(pausedUntil)');
    } else {
      conditions.push('pausedUntil = :pausedUntil');
      values[':pausedUntil'] = previous.pausedUntil;
    }

    try {
      await this.db.send(
        new PutCommand({
          TableName: this.tableName,
          Item: next,
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: values,
        }),
      );
      return 'saved';
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) throw error;
      const current = await this.load(next.subscriberId);
      if (current.status === 'migrated') return 'already-migrated';
      // Plain Error, not permanent: the retry reads the new state and migrates that.
      throw new Error('Subscriber changed during migration; it will be retried with its latest state', {
        cause: error,
      });
    }
  }
}
