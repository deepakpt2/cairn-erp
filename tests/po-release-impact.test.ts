import { describe, expect, it } from 'vitest';

import { releaseImpactingChanges } from '../src/modules/purchasing/orders';

/**
 * The gate on a released order is only as good as what it says. A refusal that could apply to
 * any field tells whoever released the order nothing about what they are being asked to
 * approve a second time.
 */
describe('what a save to a released order would move', () => {
  const before = [
    {
      itemNumber: 10,
      quantity: '100.000',
      netPrice: '10.00',
      priceUnit: '1',
      overdeliveryTolerance: '0.00',
      unlimitedOverdelivery: false,
      markedForDeletion: false,
    },
  ];

  it('finds nothing to report when nothing approved moves', () => {
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 10, quantity: 100 }],
    })).toEqual([]);
  });

  it('names a quantity that moves', () => {
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 10, quantity: 150 }],
    })).toEqual(['item 10 quantity 100 to 150']);
  });

  it('names a price that moves, with what it is per', () => {
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 10, quantity: 100, netPrice: 12, priceUnit: 1 }],
    })).toEqual(['item 10 price 10 to 12 per 1']);
  });

  it('names an overdelivery tolerance raised, and stays quiet about one lowered', () => {
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 10, quantity: 100, overdeliveryTolerance: '5' }],
    })).toEqual(['item 10 overdelivery tolerance 0% to 5%']);
    // Tightening what was approved never asks for more money.
    expect(releaseImpactingChanges({
      before: [{ ...before[0], overdeliveryTolerance: '5.00' }],
      after: [{ itemNumber: 10, quantity: 100, overdeliveryTolerance: '1' }],
    })).toEqual([]);
  });

  it('names unlimited overdelivery switched on, and stays quiet about it switched off', () => {
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 10, quantity: 100, unlimitedOverdelivery: true }],
    })).toEqual(['item 10 unlimited overdelivery set']);
    expect(releaseImpactingChanges({
      before: [{ ...before[0], unlimitedOverdelivery: true }],
      after: [{ itemNumber: 10, quantity: 100, unlimitedOverdelivery: false }],
    })).toEqual([]);
  });

  it('names an item dropped, an item added, and a deletion flag', () => {
    expect(releaseImpactingChanges({ before, after: [] })).toEqual(['item 10 removed']);
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 25, quantity: 4 }],
    })).toEqual(['item 10 removed', 'an item added at 4']);
    expect(releaseImpactingChanges({
      before,
      after: [{ itemNumber: 10, quantity: 100, markedForDeletion: true }],
    })).toEqual(['item 10 deletion set']);
  });

  it('reports every line it finds, in the order the items stand', () => {
    const impacts = releaseImpactingChanges({
      before: [before[0], { ...before[0], itemNumber: 20, quantity: '50.000', netPrice: '20.00' }],
      after: [
        { itemNumber: 10, quantity: 200, unlimitedOverdelivery: true },
        { itemNumber: 20, quantity: 50, netPrice: 25, priceUnit: 1, overdeliveryTolerance: '10' },
      ],
    });
    expect(impacts).toEqual([
      'item 10 quantity 100 to 200',
      'item 10 unlimited overdelivery set',
      'item 20 price 20 to 25 per 1',
      'item 20 overdelivery tolerance 0% to 10%',
    ]);
  });
});
