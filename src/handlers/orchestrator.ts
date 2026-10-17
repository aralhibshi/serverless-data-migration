import type { Context } from 'aws-lambda';

import { orchestrate, type OrchestratorResult } from '../migration/orchestrator/orchestrate';
import { logger } from '../utils/logger';
import { dependencies } from './dependencies';

/** Invoked directly, e.g. `serverless invoke -f orchestrator --data '{"dryRun": true}'`. */
export const handler = (event: unknown, context: Context): Promise<OrchestratorResult> => {
  logger.addContext(context);
  return orchestrate(dependencies, event);
};
