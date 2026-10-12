import { describe, expect, it } from 'vitest';
import {
  assertSupplierPaymentMethodEligibility,
  normalizeSupplierPaymentMethods,
  type SupplierPaymentMethodDefinition,
} from '@/modules/foundation/supplier-companies';

const definitions: SupplierPaymentMethodDefinition[] = [
  { methodCode: 'C', allowedDirection: 'BOTH', isActive: true },
  { methodCode: 'T', allowedDirection: 'OUTGOING', isActive: true },
  { methodCode: 'I', allowedDirection: 'INCOMING', isActive: true },
  { methodCode: 'X', allowedDirection: 'OUTGOING', isActive: false },
];

describe('Supplier company Payment Methods validation', () => {
  it('normalizes, deduplicates and sorts selected codes', () => {
    expect(normalizeSupplierPaymentMethods(' t, c C ')).toBe('C,T');
  });

  it('treats an explicit blank set as a clear', () => {
    expect(normalizeSupplierPaymentMethods(' ,  ')).toBeNull();
  });

  it.each([
    'ABC',
    'A!',
    'A,B,C,D,E,F,G,H,I,J,K',
  ])('rejects malformed or over-limit code sets (%s)', (value) => {
    expect(() => normalizeSupplierPaymentMethods(value)).toThrow();
  });

  it('allows only active OUTGOING or BOTH definitions', () => {
    expect(() => assertSupplierPaymentMethodEligibility('C,T', definitions)).not.toThrow();
    expect(() => assertSupplierPaymentMethodEligibility('C,I', definitions)).toThrow(/active outbound/);
    expect(() => assertSupplierPaymentMethodEligibility('C,X', definitions)).toThrow(/active outbound/);
    expect(() => assertSupplierPaymentMethodEligibility('C,Z', definitions)).toThrow(/active outbound/);
  });
});
