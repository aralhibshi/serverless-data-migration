import { setTimeout as sleep } from 'node:timers/promises';

import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
  type DynamoDBDocumentClient,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';

import { chunk } from '../../utils/chunk';

type Item = Record<string, unknown>;

interface Page {
  readonly Items?: Item[];
  readonly LastEvaluatedKey?: Item;
}

/** DynamoDB accepts at most 25 writes per batch. */
const DYNAMODB_MAX_BATCH_WRITE = 25;
const MAX_BATCH_WRITE_ATTEMPTS = 5;

/**
 * Base for DynamoDB repositories: maps raw items to entities and handles the mechanics every table
 * needs (consistent reads, pagination, batch writes with retries). Subclasses own their queries.
 */
export abstract class DynamoDBRepository<TEntity> {
  constructor(
    protected readonly db: DynamoDBDocumentClient,
    protected readonly tableName: string,
  ) {}

  /** Maps a raw item to the entity, validating it. */
  protected abstract toEntity(item: Item): TEntity;

  protected async getItem(key: Item): Promise<TEntity | undefined> {
    const { Item } = await this.db.send(new GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }));
    return Item === undefined ? undefined : this.toEntity(Item);
  }

  /** Follows `LastEvaluatedKey` through every page of a query or scan, yielding entities as they arrive. */
  protected async *paginate(fetchPage: (startKey: Item | undefined) => Promise<Page>): AsyncGenerator<TEntity> {
    let startKey: Item | undefined;
    do {
      const page = await fetchPage(startKey);
      for (const item of page.Items ?? []) yield this.toEntity(item);
      startKey = page.LastEvaluatedKey;
    } while (startKey !== undefined);
  }

  /** Writes items in batches of 25, retrying unprocessed items (returned under throttling) with backoff. */
  protected async batchPut(items: readonly Item[]): Promise<void> {
    for (const batch of chunk(items, DYNAMODB_MAX_BATCH_WRITE)) {
      let requests: NonNullable<BatchWriteCommandInput['RequestItems']>[string] = batch.map((Item) => ({
        PutRequest: { Item },
      }));

      for (let attempt = 1; requests.length > 0; attempt++) {
        const response = await this.db.send(new BatchWriteCommand({ RequestItems: { [this.tableName]: requests } }));
        requests = response.UnprocessedItems?.[this.tableName] ?? [];
        if (requests.length > 0 && attempt >= MAX_BATCH_WRITE_ATTEMPTS) {
          throw new Error(`Could not write ${String(requests.length)} items after ${String(attempt)} attempts`);
        }
        if (requests.length > 0) await sleep(100 * 2 ** attempt);
      }
    }
  }
}
