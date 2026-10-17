import { describe, expect, it } from 'vitest';

import { toSubscriberEntity } from '../../../src/entities/DDB/SubscriberEntity';

describe('toSubscriberEntity', () => {
  it('classifies a valid old-schema record as pending', () => {
    const item = { subscriberId: 's1', schemaVersion: 1, boxSize: 'small', status: 'active' };
    expect(toSubscriberEntity(item)).toEqual({ status: 'pending', recordId: 's1', record: item });
  });

  it('classifies a valid new-schema record as migrated', () => {
    const item = {
      subscriberId: 's1',
      schemaVersion: 2,
      status: 'cancelled',
      plan: null,
      pause: null,
      migratedFrom: { boxSize: 'small' },
    };
    expect(toSubscriberEntity(item)).toEqual({ status: 'migrated', recordId: 's1', record: item });
  });

  it.each([
    ['an unknown box size', { subscriberId: 's1', schemaVersion: 1, boxSize: 'huge', status: 'active' }],
    ['a missing schema version', { subscriberId: 's1', boxSize: 'small', status: 'active' }],
    [
      'a malformed pause date',
      { subscriberId: 's1', schemaVersion: 1, boxSize: 'small', status: 'paused', pausedUntil: 'soon' },
    ],
    ['a malformed new-schema record', { subscriberId: 's1', schemaVersion: 2, status: 'active' }],
  ])('classifies a record with %s as invalid, with a readable reason', (_, item) => {
    const result = toSubscriberEntity(item);
    expect(result).toMatchObject({ status: 'invalid', recordId: 's1' });
    expect(result.status === 'invalid' && result.reason).toMatch(/^Invalid (migrated )?record: [^\n]+$/);
  });

  it('labels a record with no id rather than dropping it', () => {
    expect(toSubscriberEntity({ schemaVersion: 1 }).recordId).toBe('(missing subscriberId)');
  });
});
