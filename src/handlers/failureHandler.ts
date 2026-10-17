import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';

import { recordDeadLetters } from '../migration/failureHandler/recordFailures';
import { logger } from '../utils/logger';
import { dependencies } from './dependencies';

/** Triggered by the dead-letter queue: tracks every record whose retries ran out as failed. */
export const handler = (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  logger.addContext(context);
  return recordDeadLetters(dependencies.tracking, event.Records);
};
