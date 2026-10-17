/**
 * A failure that retrying can't fix, such as invalid data or no matching use case.
 * The record is tracked as failed straight away instead of being retried.
 */
export class PermanentMigrationError extends Error {
  override readonly name = 'PermanentMigrationError';
}
