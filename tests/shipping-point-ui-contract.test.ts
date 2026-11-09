/**
 * DI-020 (§3.3) — the dock on the screen, pinned by source.
 *
 * The determination is only half of what the increment delivered. The other half is that a reader
 * can see where the goods left from and who they went to, and that nobody can quietly change
 * either on the document. These assertions hold the four surfaces to that:
 *
 * The configuration screen names docks, conditions and rows, and withdraws them rather than
 * deleting them — a row here is the rule a delivery was raised under.
 *
 * Every write goes through a server action that checks the same capability the page checks, because
 * a screen that shows you a form is not a screen that lets you use it.
 *
 * The delivery prints the dock it was given and the address it was raised with, and offers no field
 * to edit either: the dock was determined, and the address is where those goods went.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

const PAGE = 'src/app/config/shipping-points/page.tsx';
const ACTIONS = 'src/app/config/shipping-points/actions.ts';
const POINTS = 'src/app/config/shipping-points/ShippingPointSetup.tsx';
const CONDITIONS = 'src/app/config/shipping-points/ShippingConditionSetup.tsx';
const ASSIGNMENTS = 'src/app/config/shipping-points/ShippingPointAssignmentSetup.tsx';
const DELIVERY = 'src/app/sales/delivery/Delivery.tsx';

describe('the dock, on the screen', () => {
  it('guards the configuration screen behind one capability on both sides of the wire', () => {
    const page = read(PAGE);
    expect(page).toContain('requireSession(ROUTE)');
    expect(page).toContain('can(session, SHIPPING_POINT_CAPABILITY)');
    // The panels are offered only to somebody who holds it; everybody else is told which authority
    // they are missing rather than shown a form that will refuse them.
    expect(page).toContain('{SHIPPING_POINT_CAPABILITY}');

    const actions = read(ACTIONS);
    expect(actions).toContain("'use server'");
    const guards = actions.split('can(session, SHIPPING_POINT_CAPABILITY)').length - 1;
    const writes = actions.split('export async function ').length - 1;
    expect(guards).toBe(writes);
    expect(actions).toContain('message: `You do not hold the authority ${SHIPPING_POINT_CAPABILITY}.`');
    // A refusal at the door is not a refusal in the page: the path is revalidated so the table the
    // reader is looking at is the table as it now stands.
    expect(actions.split('revalidatePath(ROUTE)').length - 1).toBe(writes);
  });

  it('shows what stands before it offers to change it, in three sections a reader can name', () => {
    const page = read(PAGE);
    expect(page).toContain('aria-labelledby="docks"');
    expect(page).toContain('aria-labelledby="conditions"');
    expect(page).toContain('aria-labelledby="assignments"');
    // How many customers are answered by the rows naming no condition is worth saying out loud:
    // it is the difference between a tenant that has configured shipping and one that has not.
    expect(page).toContain('configuration.customersWithoutCondition');
  });

  it('names a dock as a place, and withdraws one that has stopped loading rather than deleting it', () => {
    const points = read(POINTS);
    expect(points).toContain('name="shippingPoint"');
    expect(points).toContain('maxLength={4}');
    expect(points).toContain('pattern="[A-Za-z0-9]{1,4}"');
    expect(points).toContain('Name the dock');
    expect(points).toContain('aria-labelledby="dock-withdraw"');
    // Withdrawal is the only way a dock stops: a delivery already raised names the code it was
    // raised with, and deleting the row would rewrite that delivery's history.
    expect(points).not.toContain('deleteShippingPoint');
    expect(read(ACTIONS)).not.toContain('delete');
  });

  it('describes a condition so two characters on a customer can be read', () => {
    const conditions = read(CONDITIONS);
    expect(conditions).toContain('name="shippingCondition"');
    expect(conditions).toContain('maxLength={2}');
    expect(conditions).toContain('pattern="[A-Za-z0-9]{1,2}"');
    // Withdrawing a condition that customers still carry is the interesting case, so the screen
    // says how many carry it before anybody is asked to withdraw it.
    expect(conditions).toContain('candidate.carriers');
    expect(conditions).toContain('aria-labelledby="condition-withdraw"');
  });

  it('assigns a dock by three keys, each of which may be left blank on purpose', () => {
    const assignments = read(ASSIGNMENTS);
    expect(assignments).toContain('name="deliveringPlant"');
    expect(assignments).toContain('name="shippingCondition"');
    expect(assignments).toContain('name="loadingGroup"');
    expect(assignments).toContain('name="shippingPoint"');
    // Blank is a value that is matched, so it has to be offered as one — '(any)' on the condition
    // and a placeholder on the group, not an empty box a reader cannot tell from a gap.
    expect(assignments).toContain('<option value="">(any)</option>');
    expect(assignments).toContain('placeholder="(any)"');
    // The loading group is a value the tenant writes on materials, so the box offers the ones that
    // exist rather than asking anybody to remember them.
    expect(assignments).toContain('list="loading-groups"');
    expect(assignments).toContain('id="loading-groups"');
    // A row is identified by all three keys, never by the dock it names: two rows may name one dock.
    expect(assignments).toContain('`${row.deliveringPlant}/${row.shippingCondition}/${row.loadingGroup}`');
    expect(assignments).toContain('aria-labelledby="assignment-withdraw"');
  });

  it('prints the dock a delivery loads through, and says so when it has none', () => {
    const delivery = read(DELIVERY);
    expect(delivery).toContain('shipping point {selected.shippingPoint}');
    // A delivery raised before the determination stood carries no dock. It says that, rather than
    // looking like a delivery whose dock is simply blank.
    expect(delivery).toContain('no shipping point');
    // The dock was determined, not entered: there is no field on the delivery to change it.
    expect(delivery).not.toContain('name="shippingPoint"');
  });

  it('prints where the goods went, and for a return where they came from', () => {
    const delivery = read(DELIVERY);
    expect(delivery).toContain('shipToAddress');
    expect(delivery).toContain("selected.documentType === 'LR' ? 'received from' : 'delivered to'");
    // The ship-to is named when it is not the customer on the header, so a delivery to somebody
    // else's address does not read as a delivery to the sold-to.
    expect(delivery).toContain('selected.shipTo.partnerNumber !== selected.customerNumber');
    expect(delivery).toContain('selected.shipTo.street');
    expect(delivery).toContain('selected.shipTo.city');
    // The address is printed from what the delivery carries, never read back from the master:
    // remaking a customer next month must not rewrite where last month's goods were delivered.
    expect(delivery).not.toContain('partnerAddress(');
  });
});
