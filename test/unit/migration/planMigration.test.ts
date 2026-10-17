import { describe, expect, it } from 'vitest';

import { PermanentMigrationError } from '../../../src/migration/PermanentMigrationError';
import { selectUseCase } from '../../../src/migration/planMigration';
import type { MigrationUseCase } from '../../../src/migration/types';

interface Item {
  kind: string;
}

function useCase(name: string, kind: string): MigrationUseCase<Item, Item> {
  return { name, appliesTo: (record) => record.kind === kind, migrate: (record) => record };
}

describe('selectUseCase', () => {
  const useCases = [useCase('a', 'a'), useCase('b', 'b'), useCase('also-b', 'b')];

  it('returns the one use case that applies', () => {
    expect(selectUseCase(useCases, { kind: 'a' }).name).toBe('a');
  });

  it('fails permanently when no use case applies', () => {
    expect(() => selectUseCase(useCases, { kind: 'z' })).toThrow(
      new PermanentMigrationError('No migration use case applies to this record'),
    );
  });

  it('fails permanently when several use cases apply, rather than picking one', () => {
    expect(() => selectUseCase(useCases, { kind: 'b' })).toThrow(/More than one migration use case.*b, also-b/);
  });
});
