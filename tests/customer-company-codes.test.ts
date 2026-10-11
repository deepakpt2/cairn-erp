import { describe, expect, it } from 'vitest';
import {
  normalizeInterestIndicator,
  normalizeToleranceGroup,
} from '@/modules/foundation/customer-companies';

describe('customer company interest and tolerance code normalization', () => {
  it.each([
    ['interest indicator', normalizeInterestIndicator],
    ['tolerance group', normalizeToleranceGroup],
  ])('%s is trimmed and canonicalized', (_field, normalize) => {
    expect(normalize(' t1 ')).toBe('T1');
  });

  it.each([
    ['interest indicator', normalizeInterestIndicator],
    ['tolerance group', normalizeToleranceGroup],
  ])('%s accepts blank as unset', (_field, normalize) => {
    expect(normalize('')).toBeNull();
    expect(normalize('   ')).toBeNull();
  });

  it.each([
    ['interest indicator', normalizeInterestIndicator],
    ['tolerance group', normalizeToleranceGroup],
  ])('%s rejects malformed and over-length values', (_field, normalize) => {
    expect(() => normalize('A-1')).toThrow();
    expect(() => normalize('ABCDE')).toThrow();
  });
});
