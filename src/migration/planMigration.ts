import { PermanentMigrationError } from './PermanentMigrationError';
import type { Migration, MigrationUseCase, StateSummary } from './types';

export interface MigrationPlan<TNew> {
  readonly recordId: string;
  readonly useCase: string;
  readonly before: StateSummary;
  readonly after: StateSummary;
  readonly next: TNew;
}

/** Picks the one use case that applies to a record. Zero or several matches is a permanent failure. */
export function selectUseCase<TOld, TNew>(
  useCases: readonly MigrationUseCase<TOld, TNew>[],
  record: TOld,
): MigrationUseCase<TOld, TNew> {
  const matches = useCases.filter((useCase) => useCase.appliesTo(record));
  const [match] = matches;
  if (match === undefined) throw new PermanentMigrationError('No migration use case applies to this record');
  if (matches.length > 1) {
    const names = matches.map((useCase) => useCase.name).join(', ');
    throw new PermanentMigrationError(`More than one migration use case applies to this record: ${names}`);
  }
  return match;
}

/** Works out what migrating a record would do, without writing anything. Shared by dry runs and the processor. */
export function planMigration<TOld, TNew, TFilter>(
  migration: Migration<TOld, TNew, TFilter>,
  recordId: string,
  record: TOld,
): MigrationPlan<TNew> {
  const useCase = selectUseCase(migration.useCases, record);
  const next = useCase.migrate(record);
  return {
    recordId,
    useCase: useCase.name,
    before: migration.summarizeOld(record),
    after: migration.summarizeNew(next),
    next,
  };
}
