import { describe, expect, it } from 'vitest';

import { parseMigrationMessage } from '../../../src/migration/migrationMessage';

describe('parseMigrationMessage', () => {
  it('parses a valid message', () => {
    expect(parseMigrationMessage('{"migrationId":"m","recordId":"r"}')).toEqual({ migrationId: 'm', recordId: 'r' });
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseMigrationMessage('not json')).toThrow('Message body is not valid JSON');
  });

  it('rejects a message with missing or empty ids', () => {
    expect(() => parseMigrationMessage('{"migrationId":"m"}')).toThrow();
    expect(() => parseMigrationMessage('{"migrationId":"m","recordId":""}')).toThrow();
  });
});
