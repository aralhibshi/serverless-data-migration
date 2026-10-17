import { isDeepStrictEqual } from 'node:util';

import {
  type LegacySubscriber,
  type Subscriber,
  type SubscriberEntity,
  type SubscriberFilter,
  toSubscriberEntity,
} from '../../src/entities/DDB/SubscriberEntity';
import type { MigrationSource, SaveResult } from '../../src/migration/types';

/** Mirrors SubscriberRepository's semantics in memory, for unit tests. */
export class InMemorySubscriberRepository implements MigrationSource<LegacySubscriber, Subscriber, SubscriberFilter> {
  readonly items = new Map<string, Record<string, unknown>>();
  /** Errors to throw from the next save calls, to simulate transient failures. */
  readonly saveErrors: Error[] = [];

  constructor(items: Record<string, unknown>[] = []) {
    for (const item of items) this.items.set(String(item.subscriberId), item);
  }

  async *findPending(filter: SubscriberFilter): AsyncGenerator<SubscriberEntity> {
    for (const item of this.items.values()) {
      if (item.schemaVersion === 2) continue;
      if (filter.boxSizes && !filter.boxSizes.some((boxSize) => boxSize === item.boxSize)) continue;
      yield await Promise.resolve(toSubscriberEntity(item));
    }
  }

  load(recordId: string): Promise<SubscriberEntity> {
    const item = this.items.get(recordId);
    return Promise.resolve(item === undefined ? { status: 'missing', recordId } : toSubscriberEntity(item));
  }

  save(previous: LegacySubscriber, next: Subscriber): Promise<SaveResult> {
    const error = this.saveErrors.shift();
    if (error) return Promise.reject(error);
    const current = this.items.get(next.subscriberId);
    if (current?.schemaVersion === 2) return Promise.resolve('already-migrated');
    if (!isDeepStrictEqual(current, previous)) {
      return Promise.reject(new Error('Subscriber changed during migration; it will be retried with its latest state'));
    }
    this.items.set(next.subscriberId, next);
    return Promise.resolve('saved');
  }
}
