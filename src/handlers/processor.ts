import type { Context, SQSBatchResponse, SQSEvent } from 'aws-lambda';

import { processBatch } from '../migration/processor/processRecords';
import { logger } from '../utils/logger';
import { dependencies } from './dependencies';

/** Triggered by the migration queue, with partial batch responses enabled. */
export const handler = (event: SQSEvent, context: Context): Promise<SQSBatchResponse> => {
  logger.addContext(context);
  return processBatch(dependencies, event.Records);
};
