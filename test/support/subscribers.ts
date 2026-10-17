import type { LegacySubscriber } from '../../src/entities/DDB/SubscriberEntity';

export function legacySubscriber(overrides: Partial<LegacySubscriber> & { subscriberId: string }): LegacySubscriber {
  return { schemaVersion: 1, boxSize: 'medium', status: 'active', ...overrides };
}
