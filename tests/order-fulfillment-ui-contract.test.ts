import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * §5.4 screen contract: the order says how much of each item is done, and its grid is not capped.
 *
 * These are the two things a clerk notices about the order screen before they notice anything else:
 * an item that says how much was ordered but not how much has gone, and a grid that stops at five
 * rows no matter how long the order is. Both were true of this screen, and neither is a thing a
 * service test can hold — one is a column and the other is a constant in a component — so the
 * contract is pinned against the source, as the other screen contracts in the suite are.
 *
 * The assertions that matter are the negative ones. A screen that recomputed the delivered quantity
 * instead of reading it would pass every `toContain` here and still be a second author of an
 * arithmetic the delivery service refuses by; a grid that reintroduced a fixed slot count would pass
 * everything except `not.toContain('LINE_SLOTS')`.
 */
describe('order screen contract (§5.4)', () => {
  const page = readFileSync('src/app/sales/orders/page.tsx', 'utf8');
  const shell = readFileSync('src/app/sales/orders/Orders.tsx', 'utf8');
  const actions = readFileSync('src/app/sales/orders/actions.ts', 'utf8');
  const service = readFileSync('src/modules/sales/sales-order.ts', 'utf8');
  const quantities = readFileSync('src/modules/sales/fulfillment-quantities.ts', 'utf8');

  it('shows what the chain has taken off each item, and what is left', () => {
    for (const field of ['deliveredQuantity', 'billedQuantity', 'openQuantity']) {
      expect(shell, field).toContain(`line.${field}`);
    }
    // Printed on the item grid, not buried in a detail panel a planner has to open.
    expect(shell).toContain('>Delivered<');
    expect(shell).toContain('>Billed<');
    expect(shell).toContain('>Open<');
    // Beside the quantity that was ordered and the quantity that was confirmed, because the four of
    // them are one sentence: we asked for ten, the plant promised eight, six have gone, four are left.
    expect(shell).toContain('>Confirmed<');
  });

  it('reads those quantities from the one author of the arithmetic', () => {
    // The order service reads them from fulfillment-quantities, which is what the delivery and the
    // billing services refuse things by. The screen must not have a second opinion.
    expect(service).toContain("from './fulfillment-quantities'");
    expect(service).toContain('orderLineProgress(tx, client, orderNumber)');
    expect(service).toContain('deliveredOf(progress, l.lineNumber)');
    expect(service).toContain('billedOf(progress, l.lineNumber)');
    // And the arithmetic itself still has the exclusions that make it the chain's: a cancelled
    // delivery owes nothing, and goods that came back are goods that were delivered.
    expect(quantities).toContain("status <> 'CANCELLED'");
    expect(quantities).toContain('STANDARD_RETURNS_DELIVERY_TYPE');
    // The screen renders what the view carries. It does not sum deliveries or billing lines itself.
    expect(shell).not.toContain('deliveryLine');
    expect(shell).not.toContain('billingDocumentLine');
  });

  it('the item grid grows, and is not a fixed number of slots', () => {
    // This is the assertion the whole increment would otherwise not have: the grid used to be five
    // rows on the screen and ten in the action, which is the worse of both — an order longer than
    // five items could not be typed in at all, and the two numbers disagreed about where the limit was.
    expect(shell).not.toContain('LINE_SLOTS');
    expect(actions).not.toContain('LINE_SLOTS');
    // Rows are state, and there is a way to add one.
    expect(shell).toContain('useState<GridRow[]>');
    expect(shell).toContain('Add another item');
    expect(shell).toContain('onClick={add}');
    // The grid tells the action how many rows it sent, rather than the two of them each knowing a
    // number that can drift apart.
    expect(shell).toContain('name="lineCount"');
    expect(actions).toContain("text(form, 'lineCount')");
  });

  it('a change starts from the items that stand, and a rejected item is not offered', () => {
    // A change used to mean retyping the order, because the grid opened empty every time. It opens
    // on the order's own items now. A rejected item is left out: a rejected item number is not
    // reused, so a row offering one would be offering a refusal.
    expect(shell).toContain('initialRows={rowsOf(selected)}');
    expect(shell).toContain("line.status !== 'REJECTED'");
    // And an item that stands keeps its number, so the change addresses it rather than replacing it.
    expect(shell).toContain("name={name('lineNumber')}");
  });

  it('the bound on the grid is the bound on the order, and not a number the screen invented', () => {
    // The grid has no cap a clerk will hit, but a form can say anything and a server that believed
    // it would loop. The two ends agree on the number, and neither of them is ten.
    expect(actions).toContain('MAX_POSTED_ROWS = 999');
    expect(service).toContain('max(999)');
    expect(actions).toContain('Math.min(Math.trunc(raw), MAX_POSTED_ROWS)');
    // A change still refuses an item number it does not know, which is why a new row is numbered
    // past the highest item that stands rather than by its position on the screen.
    expect(shell).toContain('nextNumber');
  });

  it('keeps the read and the write on one screen, under the capabilities they answer to', () => {
    expect(page).toContain('requireSession(SALES_ORDER_ROUTE)');
    expect(page).toContain('can(session, SALES_ORDER_CAPABILITY)');
    expect(page).toContain('can(session, SALES_ORDER_RELEASE_CAPABILITY)');
    expect(page).toContain('export const dynamic');
    expect(actions).toContain("'use server'");
    expect(actions).toContain('can(session, SALES_ORDER_CAPABILITY)');
  });
});
