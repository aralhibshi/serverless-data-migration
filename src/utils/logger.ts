import { Logger } from '@aws-lambda-powertools/logger';

/**
 * Structured JSON logs via Powertools for AWS Lambda, so CloudWatch Logs Insights can filter by field.
 * Handlers add the Lambda context (request id, cold start, function name) to every log line.
 */
export const logger = new Logger({ serviceName: 'serverless-data-migration' });
