import type { LegacySubscriber, Subscriber } from '../../entities/DDB/SubscriberEntity';
import { PermanentMigrationError } from '../../migration/PermanentMigrationError';
import type { MigrationUseCase } from '../../migration/types';
import { carriedOver, equivalentPlan } from './subscriberPlan';

/** Paused subscribers keep their pause, which must have an end date. */
export class PausedSubscriberUseCase implements MigrationUseCase<LegacySubscriber, Subscriber> {
  readonly name = 'paused-subscriber';

  appliesTo(subscriber: LegacySubscriber): boolean {
    return subscriber.status === 'paused';
  }

  migrate(subscriber: LegacySubscriber): Subscriber {
    if (subscriber.pausedUntil === undefined) {
      throw new PermanentMigrationError('Paused subscriber has no pausedUntil date');
    }
    return {
      ...carriedOver(subscriber),
      plan: equivalentPlan(subscriber),
      pause: { resumesOn: subscriber.pausedUntil },
    };
  }
}
