/**
 * MIGO — the action/reference matrix, as data — SCR-139 / INV.MIGO.POST (MIGO as a search alias only).
 *
 * SAP has one MIGO screen, not one per movement: an **action** and a **reference document
 * type** together select the movement. Canon carries the same two selectors, and every cell
 * of the matrix resolves to exactly one of three answers:
 *
 *   POST_HERE  — this screen posts it (A07 + R08 261, A01 + R08 101, A04 + R10 311/301/321)
 *   ELSEWHERE  — a delivered capability already posts it, and the cell links there rather
 *                than implementing a second copy of the same posting
 *   REFUSED    — nothing posts it yet; the cell names the capability that would light it up
 *
 * The matrix is a table so that a later round adds a row and not a screen.
 */
export const MIGO_CAPABILITY = 'INV.MIGO.POST';
export const MIGO_ROUTE = '/inventory/migo';
export const MIGO_ALIAS = 'MIGO';

export interface MigoAction {
  value: string;
  label: string;
  meaning: string;
}

export interface MigoReference {
  value: string;
  label: string;
  meaning: string;
}

export const MIGO_ACTIONS: readonly MigoAction[] = [
  { value: 'A01', label: 'Goods receipt', meaning: 'stock arrives' },
  { value: 'A02', label: 'Return delivery', meaning: 'stock goes back to its source' },
  { value: 'A03', label: 'Cancellation', meaning: 'the document is cancelled' },
  { value: 'A04', label: 'Transfer posting', meaning: 'stock moves without leaving the company' },
  { value: 'A07', label: 'Goods issue', meaning: 'stock leaves, charged to something' },
] as const;

export const MIGO_REFERENCES: readonly MigoReference[] = [
  { value: 'R01', label: 'Purchase order', meaning: "the receipt's origin is a purchase order" },
  { value: 'R04', label: 'Reservation', meaning: "the issue's origin is a reservation" },
  { value: 'R05', label: 'Material document', meaning: 'the document itself is the reference' },
  { value: 'R08', label: 'Order', meaning: 'the origin is a production order' },
  // SAP's "Other": the movement names no preceding document, which is what a transfer posting is.
  { value: 'R10', label: 'Other', meaning: 'the movement names no preceding document' },
] as const;

export type MigoResolution =
  | {
      kind: 'POST_HERE';
      /** Which form posts it — the three shapes need different fields. */
      form: 'ISSUE' | 'RECEIPT' | 'TRANSFER';
      movement: string;
      /** Where the movement is chosen per item rather than fixed by the cell. */
      movements?: readonly string[];
      title: string;
      /** The capability the posting runs under. */
      capability: string;
    }
  | {
      kind: 'ELSEWHERE';
      capability: string;
      route: string;
      title: string;
      /** Why this screen does not post it: a second implementation would be a second answer. */
      reason: string;
    }
  | {
      kind: 'REFUSED';
      title: string;
      reason: string;
      /** The capability that would light this cell up. */
      deliveredBy: string | null;
    };

const elsewhere = (capability: string, route: string, title: string): MigoResolution => ({
  kind: 'ELSEWHERE', capability, route, title,
  reason: 'Canon posts this movement through its own capability; a second implementation here would be a second answer to the same question.',
});

const refused = (title: string, reason: string, deliveredBy: string | null = null): MigoResolution => ({
  kind: 'REFUSED', title, reason, deliveredBy,
});

/**
 * Resolve one cell of the matrix. An empty selector is not an error — it is the honest
 * "choose both" state the screen shows before the reader has chosen anything.
 */
export function resolveMigoCell(action: string, reference: string): MigoResolution | null {
  if (!action && !reference) return null;
  if (!action || !reference) return null;

  // The two cells this screen posts: the issue to an order, and its finished good coming back.
  if (action === 'A07' && reference === 'R08') {
    return {
      kind: 'POST_HERE', form: 'ISSUE', movement: '261',
      title: 'Goods issue to a production order',
      capability: MIGO_CAPABILITY,
    };
  }
  if (action === 'A01' && reference === 'R08') {
    return {
      kind: 'POST_HERE', form: 'RECEIPT', movement: '101',
      title: 'Goods receipt from a production order',
      capability: MIGO_CAPABILITY,
    };
  }

  // A transfer posting names no preceding document: SAP's "Other", movement chosen on the item.
  if (action === 'A04' && reference === 'R10') {
    return {
      kind: 'POST_HERE', form: 'TRANSFER', movement: '311/301/321',
      movements: ['311', '301', '321'],
      title: 'Transfer posting',
      capability: MIGO_CAPABILITY,
    };
  }

  // A cancellation is the reversal document, whichever document it cancels.
  if (action === 'A03') {
    return elsewhere('INV.REVERSE', '/inventory/reversal', 'Cancellation of a material document');
  }

  // A transfer posting carries no other reference: there is no document to attach it to.
  if (action === 'A04') {
    return refused(
      'Transfer posting against a reference document',
      'A transfer posting names no preceding document — SAP enters it against "Other" — so a purchase order, a reservation, a material document or an order would be a reference it cannot honour.',
      'R10',
    );
  }

  // The material document as the reference is a display question unless something is cancelled.
  if (reference === 'R05') {
    return elsewhere('INV.DISPLAY', '/inventory/material-documents', 'Display the material document');
  }

  if (action === 'A01' && reference === 'R01') {
    return elsewhere('INV.GR.POST', '/inventory/goods-receipt', 'Goods receipt for a purchase order');
  }
  if (action === 'A07' && reference === 'R04') {
    return elsewhere('INV.GI.POST', '/inventory/goods-issue', 'Goods issue against a reservation');
  }

  if (action === 'A02') {
    return refused(
      'Return delivery',
      'Canon carries no returns chain: nothing records a return to a vendor, so a return delivery would be a document with no counterparty.',
      null,
    );
  }
  if (action === 'A01' && reference === 'R04') {
    return refused(
      'Goods receipt against a reservation',
      'A reservation is a planned withdrawal; a receipt against one is not a movement canon names.',
      null,
    );
  }
  if (action === 'A07' && reference === 'R01') {
    return refused(
      'Goods issue against a purchase order',
      'A purchase order issues nothing in canon; the vendor return that would is the return delivery deferred above.',
      null,
    );
  }

  return refused(
    `${action} with reference ${reference}`,
    'This cell of the matrix has no movement behind it in canon.',
    null,
  );
}

/** Every cell, for the matrix table the screen can show and the tests can assert. */
export function migoMatrix(): Array<{
  action: MigoAction;
  reference: MigoReference;
  resolution: MigoResolution;
}> {
  const rows: Array<{ action: MigoAction; reference: MigoReference; resolution: MigoResolution }> = [];
  for (const action of MIGO_ACTIONS) {
    for (const reference of MIGO_REFERENCES) {
      const resolution = resolveMigoCell(action.value, reference.value);
      if (resolution) rows.push({ action, reference, resolution });
    }
  }
  return rows;
}
