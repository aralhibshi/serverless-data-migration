import type { BoxSize, LegacySubscriber, Subscriber } from '../../entities/DDB/SubscriberEntity';

export const mealsPerWeekByBoxSize = { small: 3, medium: 5, large: 8 } as const satisfies Record<BoxSize, number>;

/** The meals-per-week plan equivalent to a subscriber's old box size. */
export function equivalentPlan(subscriber: LegacySubscriber): Subscriber['plan'] {
  return { mealsPerWeek: mealsPerWeekByBoxSize[subscriber.boxSize] };
}

/** The fields every migrated subscriber carries over, whatever its use case. */
export function carriedOver(
  subscriber: LegacySubscriber,
): Pick<Subscriber, 'subscriberId' | 'schemaVersion' | 'status' | 'migratedFrom'> {
  return {
    subscriberId: subscriber.subscriberId,
    schemaVersion: 2,
    status: subscriber.status,
    migratedFrom: { boxSize: subscriber.boxSize },
  };
}
