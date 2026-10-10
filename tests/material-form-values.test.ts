import { describe, expect, it } from 'vitest';
import { materialFormValue } from '../src/modules/inventory/form-values';
describe('saved material field defaults', () => {
  it('uses defaults only for a missing new-record field', () => {
    expect(materialFormValue({}, 'mrpController', '001')).toBe('001');
  });
  it('preserves a deliberately unset saved controller', () => {
    expect(materialFormValue({ mrpController: null }, 'mrpController', '001')).toBe('');
  });
  it('preserves a deliberately empty saved purchasing group', () => {
    expect(materialFormValue({ purchasingGroup: '' }, 'purchasingGroup', '001')).toBe('');
  });
  it('preserves zero, false and exact decimal strings', () => {
    expect(materialFormValue({ lead: 0 }, 'lead', '7')).toBe('0');
    expect(materialFormValue({ flag: false }, 'flag', 'true')).toBe('false');
    expect(materialFormValue({ quantity: '12.375' }, 'quantity', '0')).toBe('12.375');
  });
  it('uses an explicit fallback for undefined fields only', () => {
    expect(materialFormValue({ orderUnit: undefined }, 'orderUnit', 'KG')).toBe('KG');
    expect(materialFormValue({ orderUnit: null }, 'orderUnit', 'KG')).toBe('');
  });
});
