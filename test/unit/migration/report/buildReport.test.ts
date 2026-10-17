import { describe, expect, it } from 'vitest';

import type { MigrationTrackingEntity } from '../../../../src/entities/DDB/MigrationTrackingEntity';
import { buildReport, csvCell } from '../../../../src/migration/report/buildReport';

const updatedAt = '2026-01-01T00:00:00.000Z';

describe('buildReport', () => {
  it('summarises outcomes and lists every record with its before and after state', () => {
    const entries: MigrationTrackingEntity[] = [
      {
        migrationId: 'm',
        recordId: 'r1',
        status: 'succeeded',
        useCase: 'active',
        before: { plan: 'small box' },
        after: { plan: '3 meals/week' },
        attempts: 0,
        updatedAt,
      },
      { migrationId: 'm', recordId: 'r2', status: 'failed', reason: 'Bad, data', attempts: 3, updatedAt },
      { migrationId: 'm', recordId: 'r3', status: 'queued', before: { plan: 'large box' }, attempts: 0, updatedAt },
    ];

    const report = buildReport('m', entries);

    expect(report.summary).toEqual({ total: 3, queued: 1, succeeded: 1, failed: 1 });
    expect(report.csv.split('\n')).toEqual([
      'record_id,status,use_case,before_plan,after_plan,reason,attempts,updated_at',
      `r1,succeeded,active,small box,3 meals/week,,0,${updatedAt}`,
      `r2,failed,,,,"Bad, data",3,${updatedAt}`,
      `r3,queued,,large box,,,0,${updatedAt}`,
      '',
    ]);
  });

  it('orders before and after columns the same way however the stored keys are ordered', () => {
    const entries: MigrationTrackingEntity[] = [
      { migrationId: 'm', recordId: 'r1', status: 'queued', before: { b: '1', a: '2' }, attempts: 0, updatedAt },
      { migrationId: 'm', recordId: 'r2', status: 'queued', before: { a: '3', b: '4' }, attempts: 0, updatedAt },
    ];

    expect(buildReport('m', entries).csv.split('\n').slice(0, 3)).toEqual([
      'record_id,status,use_case,before_a,before_b,reason,attempts,updated_at',
      `r1,queued,,2,1,,0,${updatedAt}`,
      `r2,queued,,3,4,,0,${updatedAt}`,
    ]);
  });

  it('produces a header-only CSV for a migration with no records', () => {
    const report = buildReport('m', []);
    expect(report.summary.total).toBe(0);
    expect(report.csv).toBe('record_id,status,use_case,reason,attempts,updated_at\n');
  });
});

describe('csvCell', () => {
  it('quotes values containing commas, quotes or newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('stops spreadsheets from treating a value as a formula', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('@cmd')).toBe("'@cmd");
  });
});
