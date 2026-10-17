import { z } from 'zod';

/** The queue message: one per record. It carries ids only; the processor reads the current state itself. */
export const migrationMessageSchema = z.object({
  migrationId: z.string().min(1),
  recordId: z.string().min(1),
});

export type MigrationMessage = z.infer<typeof migrationMessageSchema>;

/** The parts of an SQS record the pipeline reads. */
export interface QueueRecord {
  readonly messageId: string;
  readonly body: string;
}

export function parseMigrationMessage(body: string): MigrationMessage {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('Message body is not valid JSON');
  }
  return migrationMessageSchema.parse(json);
}
