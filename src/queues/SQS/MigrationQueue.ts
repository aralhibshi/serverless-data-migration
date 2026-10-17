import { setTimeout as sleep } from 'node:timers/promises';

import { SendMessageBatchCommand, type SQSClient } from '@aws-sdk/client-sqs';

import type { MigrationMessage } from '../../migration/migrationMessage';
import type { RecordQueue } from '../../migration/types';
import { chunk } from '../../utils/chunk';

/** SQS accepts at most 10 messages per batch. */
export const SQS_MAX_BATCH_SIZE = 10;
const MAX_SEND_ATTEMPTS = 3;

export class MigrationQueue implements RecordQueue {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async send(messages: readonly MigrationMessage[]): Promise<void> {
    for (const batch of chunk(messages, SQS_MAX_BATCH_SIZE)) {
      let entries = batch.map((message, index) => ({ Id: String(index), MessageBody: JSON.stringify(message) }));

      // A batch can partly fail; resend only the failed entries.
      for (let attempt = 1; entries.length > 0; attempt++) {
        const response = await this.sqs.send(
          new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: entries }),
        );
        const failed = response.Failed ?? [];
        const failedIds = new Set(failed.map((entry) => entry.Id));
        entries = entries.filter((entry) => failedIds.has(entry.Id));

        if (entries.length > 0 && attempt >= MAX_SEND_ATTEMPTS) {
          const codes = [...new Set(failed.map((entry) => entry.Code))].join(', ');
          throw new Error(
            `Failed to enqueue ${String(entries.length)} messages after ${String(attempt)} attempts (${codes})`,
          );
        }
        if (entries.length > 0) await sleep(100 * 2 ** attempt);
      }
    }
  }
}
