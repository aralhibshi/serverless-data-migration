import type { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { describe, expect, it, vi } from 'vitest';

import { MigrationQueue } from '../../../src/queues/SQS/MigrationQueue';

const messages = Array.from({ length: 12 }, (_, index) => ({ migrationId: 'm', recordId: `r${String(index)}` }));

function fakeSqs(responses: { Failed?: { Id: string; Code: string; SenderFault: boolean }[] }[]) {
  const send = vi.fn((_command: SendMessageBatchCommand) => Promise.resolve(responses.shift() ?? {}));
  // A minimal stand-in: the queue only calls `send`.
  return { send, client: { send } as unknown as SQSClient };
}

describe('MigrationQueue', () => {
  it('sends messages in batches of at most 10', async () => {
    const { send, client } = fakeSqs([]);

    await new MigrationQueue(client, 'url').send(messages);

    expect(send.mock.calls.map(([command]) => command.input.Entries?.length)).toEqual([10, 2]);
    expect(send.mock.calls[0]?.[0].input.Entries?.[0]?.MessageBody).toBe('{"migrationId":"m","recordId":"r0"}');
  });

  it('resends only the entries that failed', async () => {
    const { send, client } = fakeSqs([{ Failed: [{ Id: '3', Code: 'InternalError', SenderFault: false }] }]);

    await new MigrationQueue(client, 'url').send(messages.slice(0, 5));

    expect(send.mock.calls[1]?.[0].input.Entries).toEqual([{ Id: '3', MessageBody: JSON.stringify(messages[3]) }]);
  });

  it('throws when entries keep failing, rather than dropping them', async () => {
    const failed = { Failed: [{ Id: '0', Code: 'InternalError', SenderFault: false }] };
    const { client } = fakeSqs([failed, failed, failed]);

    await expect(new MigrationQueue(client, 'url').send(messages.slice(0, 1))).rejects.toThrow(
      'Failed to enqueue 1 messages after 3 attempts (InternalError)',
    );
  });
});
