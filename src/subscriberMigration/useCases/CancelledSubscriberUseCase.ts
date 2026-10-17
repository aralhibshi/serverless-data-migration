import type { LegacySubscriber, Subscriber } from '../../entities/DDB/SubscriberEntity';
import type { MigrationUseCase } from '../../migration/types';
import { carriedOver } from './subscriberPlan';

/** Cancelled subscribers move to the new schema with no plan. */
export class CancelledSubscriberUseCase implements MigrationUseCase<LegacySubscriber, Subscriber> {
  readonly name = 'cancelled-subscriber';

  appliesTo(subscriber: LegacySubscriber): boolean {
    return subscriber.status === 'cancelled';
  }

  migrate(subscriber: LegacySubscriber): Subscriber {
    return { ...carriedOver(subscriber), plan: null, pause: null };
  }
}
