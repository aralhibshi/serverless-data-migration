import type { Context } from 'aws-lambda';

import { buildReport, type MigrationReport } from '../migration/report/buildReport';
import { logger } from '../utils/logger';
import { dependencies } from './dependencies';

/** Invoked directly; returns a summary and a CSV of every record's outcome. */
export const handler = async (_event: unknown, context: Context): Promise<MigrationReport> => {
  logger.addContext(context);
  const { migration, tracking } = dependencies;
  return buildReport(migration.id, await tracking.list(migration.id));
};
