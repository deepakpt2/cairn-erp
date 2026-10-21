import { describe, expect, it } from 'vitest';

import {
  MIGO_REFERENCES, migoMatrix, resolveMigoCell,
} from '../src/modules/inventory/migo';
import { TRANSFER_SCENARIOS } from '../src/modules/inventory/transfer-scenarios';

/**
 * SCR-141 / MIGO A04: the transfer posting is entered on the same screen as every other
 * movement, against SAP's "Other" reference, with the movement chosen on the item — and it
 * runs through the one transfer engine MB1B already uses, not a second copy of it.
 */
describe('SCR-141 MIGO A04 transfer posting', () => {
  it('carries SAP’s fifth reference, Other', () => {
    expect(MIGO_REFERENCES.map((r) => r.value)).toEqual(['R01', 'R04', 'R05', 'R08', 'R10']);
    expect(MIGO_REFERENCES.find((r) => r.value === 'R10')?.label).toBe('Other');
  });

  it('grows the matrix to 25 cells and still resolves every one', () => {
    const cells = migoMatrix();
    expect(cells).toHaveLength(25);
    for (const cell of cells) {
      expect(['POST_HERE', 'ELSEWHERE', 'REFUSED']).toContain(cell.resolution.kind);
    }
  });

  it('posts A04 + R10 with the movement chosen on the item', () => {
    const cell = resolveMigoCell('A04', 'R10');
    expect(cell).toMatchObject({
      kind: 'POST_HERE', form: 'TRANSFER', movement: '311/301/321',
      movements: ['311', '301', '321'], capability: 'INV.MIGO.POST',
    });
  });

  it('offers exactly the three transfer movements canon carries, and nothing else', () => {
    const cell = resolveMigoCell('A04', 'R10');
    if (cell?.kind !== 'POST_HERE') throw new Error('A04 + R10 must post here');
    expect(cell.movements).toEqual(TRANSFER_SCENARIOS.map((s) => s.code));
  });

  it('keeps the other three posting cells exactly as they were', () => {
    expect(resolveMigoCell('A07', 'R08')).toMatchObject({ kind: 'POST_HERE', form: 'ISSUE', movement: '261' });
    expect(resolveMigoCell('A01', 'R08')).toMatchObject({ kind: 'POST_HERE', form: 'RECEIPT', movement: '101' });
    const posting = migoMatrix().filter((c) => c.resolution.kind === 'POST_HERE');
    expect(posting.map((c) => `${c.action.value}+${c.reference.value}`)).toEqual(['A01+R08', 'A04+R10', 'A07+R08']);
  });

  it('refuses a transfer against anything but Other, naming Other', () => {
    for (const reference of ['R01', 'R04', 'R05', 'R08']) {
      const cell = resolveMigoCell('A04', reference);
      expect(cell).toMatchObject({ kind: 'REFUSED', deliveredBy: 'R10' });
      if (cell?.kind !== 'REFUSED') throw new Error('expected a refusal');
      expect(cell.reason).toMatch(/names no preceding document/);
    }
  });

  it('leaves the transfer capability where it stands, for the reader who goes there directly', () => {
    expect(resolveMigoCell('A01', 'R01')).toMatchObject({ kind: 'ELSEWHERE', capability: 'INV.GR.POST' });
    expect(resolveMigoCell('A03', 'R01')).toMatchObject({ kind: 'ELSEWHERE', capability: 'INV.REVERSE' });
  });
});
