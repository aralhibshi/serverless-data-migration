import type { MigrationMessage } from '../../src/migration/migrationMessage';
import type { RecordQueue } from '../../src/migration/types';

export class RecordingQueue implements RecordQueue {
  readonly batches: MigrationMessage[][] = [];

  get messages(): MigrationMessage[] {
    return this.batches.flat();
  }

  send(messages: readonly MigrationMessage[]): Promise<void> {
    this.batches.push([...messages]);
    return Promise.resolve();
  }
}
