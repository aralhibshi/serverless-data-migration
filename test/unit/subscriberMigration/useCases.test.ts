import { describe, expect, it } from 'vitest';

import { subscriptionStatuses } from '../../../src/entities/DDB/SubscriberEntity';
import { PermanentMigrationError } from '../../../src/migration/PermanentMigrationError';
import { selectUseCase } from '../../../src/migration/planMigration';
import { subscriberUseCases } from '../../../src/subscriberMigration/subscriberMigration';
import { ActiveSubscriberUseCase } from '../../../src/subscriberMigration/useCases/ActiveSubscriberUseCase';
import { CancelledSubscriberUseCase } from '../../../src/subscriberMigration/useCases/CancelledSubscriberUseCase';
import { PausedSubscriberUseCase } from '../../../src/subscriberMigration/useCases/PausedSubscriberUseCase';

const activeSubscriber = new ActiveSubscriberUseCase();
const pausedSubscriber = new PausedSubscriberUseCase();
const cancelledSubscriber = new CancelledSubscriberUseCase();
import { legacySubscriber } from '../../support/subscribers';

describe('subscriber use cases', () => {
  it.each(subscriptionStatuses)('exactly one use case applies to a %s subscriber', (status) => {
    expect(() => selectUseCase(subscriberUseCases, legacySubscriber({ subscriberId: 's1', status }))).not.toThrow();
  });

  it('moves an active subscriber to the equivalent meals-per-week plan', () => {
    expect(activeSubscriber.migrate(legacySubscriber({ subscriberId: 's1', boxSize: 'small' }))).toEqual({
      subscriberId: 's1',
      schemaVersion: 2,
      status: 'active',
      plan: { mealsPerWeek: 3 },
      pause: null,
      migratedFrom: { boxSize: 'small' },
    });
  });

  it('keeps a paused subscriber paused until the same date', () => {
    const subscriber = legacySubscriber({ subscriberId: 's1', status: 'paused', pausedUntil: '2026-04-01' });
    expect(pausedSubscriber.migrate(subscriber)).toMatchObject({
      status: 'paused',
      plan: { mealsPerWeek: 5 },
      pause: { resumesOn: '2026-04-01' },
    });
  });

  it('fails permanently for a paused subscriber with no end date', () => {
    const subscriber = legacySubscriber({ subscriberId: 's1', status: 'paused' });
    expect(() => pausedSubscriber.migrate(subscriber)).toThrow(PermanentMigrationError);
  });

  it('gives a cancelled subscriber no plan, but keeps where they came from', () => {
    const subscriber = legacySubscriber({ subscriberId: 's1', status: 'cancelled', boxSize: 'large' });
    expect(cancelledSubscriber.migrate(subscriber)).toMatchObject({
      status: 'cancelled',
      plan: null,
      pause: null,
      migratedFrom: { boxSize: 'large' },
    });
  });
});
