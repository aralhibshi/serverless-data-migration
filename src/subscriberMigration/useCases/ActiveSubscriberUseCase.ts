import type { LegacySubscriber, Subscriber } from '../../entities/DDB/SubscriberEntity';
import type { MigrationUseCase } from '../../migration/types';
import { carriedOver, equivalentPlan } from './subscriberPlan';

/** Active subscribers move to the equivalent meals-per-week plan. */
export class ActiveSubscriberUseCase implements MigrationUseCase<LegacySubscriber, Subscriber> {
  readonly name = 'active-subscriber';

  appliesTo(subscriber: LegacySubscriber): boolean {
    return subscriber.status === 'active';
  }

  migrate(subscriber: LegacySubscriber): Subscriber {
    return { ...carriedOver(subscriber), plan: equivalentPlan(subscriber), pause: null };
  }
}
