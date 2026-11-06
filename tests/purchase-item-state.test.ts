import { describe, expect, it } from 'vitest';

import {
  purchaseHeaderState, purchaseItemState, type PurchaseItemState,
} from '../src/modules/purchasing/item-state';

/**
 * The word an item is given. Two screens show it, so it is derived in one place, and the
 * rule that matters is the one the quantities cannot say: an item somebody closed is closed
 * at any quantity.
 */
describe('what a purchase order item is called', () => {
  const base = {
    markedForDeletion: false, deliveryCompleted: false, finalInvoiceIndicator: false,
  };

  const word = (patch: Partial<Parameters<typeof purchaseItemState>[0]>): PurchaseItemState =>
    purchaseItemState({ ...base, ordered: 10, received: 0, invoiced: 0, ...patch });

  it('follows the quantities where nobody has closed anything', () => {
    expect(word({})).toBe('OPEN');
    expect(word({ received: 4 })).toBe('PARTIALLY_DELIVERED');
    expect(word({ received: 10 })).toBe('DELIVERED');
    expect(word({ received: 10, invoiced: 10 })).toBe('COMPLETED');
    expect(word({ markedForDeletion: true, received: 10 })).toBe('MARKED');
  });

  it('calls a closed item delivered however little arrived, and complete when both ends are shut', () => {
    // 6 of 10, closed to delivery. The rest is not coming, so "partially delivered" would
    // send somebody looking for it.
    expect(word({ received: 6, deliveryCompleted: true })).toBe('DELIVERED');
    // Closed to delivery and to invoicing: nothing further will happen to this item at all.
    expect(word({ received: 6, deliveryCompleted: true, finalInvoiceIndicator: true })).toBe('COMPLETED');
    // Closed to invoicing alone does not deliver goods that have not arrived.
    expect(word({ received: 6, finalInvoiceIndicator: true })).toBe('PARTIALLY_DELIVERED');
  });

  it('does not call an item complete on a rounding hair', () => {
    expect(word({ received: 9.999999999 })).toBe('DELIVERED');
  });

  it('gives an order one word over its items, and mixed where they differ', () => {
    expect(purchaseHeaderState(['OPEN', 'OPEN'])).toBe('OPEN');
    expect(purchaseHeaderState(['DELIVERED', 'COMPLETED'])).toBe('MIXED');
    expect(purchaseHeaderState([])).toBe('OPEN');
  });
});
