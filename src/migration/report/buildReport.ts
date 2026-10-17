import type { MigrationTrackingEntity, TrackingStatus } from '../../entities/DDB/MigrationTrackingEntity';

export interface MigrationReport {
  readonly migrationId: string;
  readonly summary: Record<TrackingStatus | 'total', number>;
  /** One row per record: outcome, before and after state, and the failure reason if any. */
  readonly csv: string;
}

export function buildReport(migrationId: string, entries: readonly MigrationTrackingEntity[]): MigrationReport {
  const summary = { total: entries.length, queued: 0, succeeded: 0, failed: 0 };
  for (const entry of entries) summary[entry.status]++;

  // Before/after columns come from the migration's summaries. Sorted, because DynamoDB maps don't keep key order.
  const beforeKeys = uniqueKeys(entries.map((entry) => entry.before));
  const afterKeys = uniqueKeys(entries.map((entry) => entry.after));

  const header = [
    'record_id',
    'status',
    'use_case',
    ...beforeKeys.map((key) => `before_${key}`),
    ...afterKeys.map((key) => `after_${key}`),
    'reason',
    'attempts',
    'updated_at',
  ];
  const rows = entries.map((entry) => [
    entry.recordId,
    entry.status,
    entry.useCase ?? '',
    ...beforeKeys.map((key) => entry.before?.[key] ?? ''),
    ...afterKeys.map((key) => entry.after?.[key] ?? ''),
    entry.reason ?? '',
    String(entry.attempts),
    entry.updatedAt,
  ]);

  return { migrationId, summary, csv: toCsv([header, ...rows]) };
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** Quotes where needed, and neutralises leading characters that spreadsheets would run as formulas. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function uniqueKeys(summaries: readonly (Record<string, string> | undefined)[]): string[] {
  const keys = new Set<string>();
  for (const summary of summaries) for (const key of Object.keys(summary ?? {})) keys.add(key);
  return [...keys].sort();
}
