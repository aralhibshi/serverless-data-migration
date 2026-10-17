import {
  type LegacySubscriber,
  type Subscriber,
  type SubscriberFilter,
  subscriberFilterSchema,
} from '../entities/DDB/SubscriberEntity';
import type { Migration, MigrationSource } from '../migration/types';
import { ActiveSubscriberUseCase } from './useCases/ActiveSubscriberUseCase';
import { CancelledSubscriberUseCase } from './useCases/CancelledSubscriberUseCase';
import { PausedSubscriberUseCase } from './useCases/PausedSubscriberUseCase';

export type SubscriberMigration = Migration<LegacySubscriber, Subscriber, SubscriberFilter>;

export const SUBSCRIBER_MIGRATION_ID = 'subscribers-box-to-meal-plan';

export const subscriberUseCases = [
  new ActiveSubscriberUseCase(),
  new PausedSubscriberUseCase(),
  new CancelledSubscriberUseCase(),
] as const;

export function createSubscriberMigration(
  source: MigrationSource<LegacySubscriber, Subscriber, SubscriberFilter>,
): SubscriberMigration {
  return {
    id: SUBSCRIBER_MIGRATION_ID,
    filterSchema: subscriberFilterSchema,
    source,
    useCases: subscriberUseCases,
    summarizeOld: (subscriber) => ({
      plan: `${subscriber.boxSize} box`,
      status: subscriber.status,
      pause: subscriber.pausedUntil === undefined ? 'none' : `until ${subscriber.pausedUntil}`,
    }),
    summarizeNew: (subscriber) => ({
      plan: subscriber.plan === null ? 'none' : `${String(subscriber.plan.mealsPerWeek)} meals/week`,
      status: subscriber.status,
      pause: subscriber.pause === null ? 'none' : `until ${subscriber.pause.resumesOn}`,
    }),
  };
}
