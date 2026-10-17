import { describe, expect, it } from 'vitest';

import { errorMessage } from '../../../src/utils/errorMessage';

describe('errorMessage', () => {
  it('includes the error name and message', () => {
    expect(errorMessage(new TypeError('bad input'))).toBe('TypeError: bad input');
  });

  it('describes a thrown value that is not an Error', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
  });
});
