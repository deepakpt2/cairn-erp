/**
 * What a purchase order item is, as one word a buyer reads.
 *
 * Quantities decide it until somebody closes the item. A closed item is closed at any
 * quantity: an item flagged delivery-completed at 60 received of 100 will never receive
 * another thing, and calling it "partially delivered" would send somebody looking for goods
 * that are not coming.
 *
 * Two screens show this word - the order display and the order list - and they must not
 * disagree, so it is derived here and nowhere else.
 */

export type PurchaseItemState =
  | 'OPEN'
  | 'PARTIALLY_DELIVERED'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'MARKED';

/** Same word over a set of items, which is what an order header shows. */
export type PurchaseHeaderState = PurchaseItemState | 'MIXED';

export function purchaseItemState(input: {
  markedForDeletion: boolean;
  deliveryCompleted: boolean;
  finalInvoiceIndicator: boolean;
  ordered: number;
  received: number;
  invoiced: number;
}): PurchaseItemState {
  if (input.markedForDeletion) return 'MARKED';
  // Closed at both ends: nothing more will arrive and nothing more will be invoiced.
  if (input.deliveryCompleted && input.finalInvoiceIndicator) return 'COMPLETED';
  // Closed to delivery. It may still be invoiced, but the goods are done.
  if (input.deliveryCompleted) return 'DELIVERED';
  const { ordered, received, invoiced } = input;
  if (received >= ordered - 1e-9 && invoiced >= ordered - 1e-9) return 'COMPLETED';
  if (received >= ordered - 1e-9) return 'DELIVERED';
  if (received > 0) return 'PARTIALLY_DELIVERED';
  return 'OPEN';
}

export function purchaseHeaderState(states: PurchaseItemState[]): PurchaseHeaderState {
  if (states.length === 0) return 'OPEN';
  return states.every((state) => state === states[0]) ? states[0] : 'MIXED';
}
