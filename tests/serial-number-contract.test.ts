import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * §5.5b contract: one thing at a time, and who can say which.
 *
 * The behaviour is proved against a database in `sales-serial-numbers.test.ts`. What is pinned here
 * is the shape of the wiring, and the negative assertions are the ones that earn their place.
 *
 * **The client component must not import the module that reads the master.** This is the same
 * failure that put the batch determination screen at 500: `serial-number.ts` imports its tables, and
 * a browser component that imports it takes the whole of `postgres` with it. The statuses live in
 * their own file for exactly that reason, and this test is why the reason does not quietly vanish.
 *
 * **A material that is not counted in serials must not be asked.** `serial_managed` defaults to
 * false, so every material that stands picks as it always did. A version that asked every pick for
 * serials would pass every positive assertion and stop the warehouse.
 *
 * **The count has to be exact, and a unit goes out once.** Both are refusals in the module, and
 * both are the kind of thing a later edit removes by accident because removing them makes more
 * picks succeed.
 */
describe('serial number contract (§5.5b)', () => {
  const page = readFileSync('src/app/inventory/serial-numbers/page.tsx', 'utf8');
  const shell = readFileSync('src/app/inventory/serial-numbers/SerialNumbers.tsx', 'utf8');
  const actions = readFileSync('src/app/inventory/serial-numbers/actions.ts', 'utf8');
  const module_ = readFileSync('src/modules/inventory/serial-number.ts', 'utf8');
  const statuses = readFileSync('src/modules/inventory/serial-status.ts', 'utf8');
  const delivery = readFileSync('src/modules/sales/delivery.ts', 'utf8');
  const transfer = readFileSync('src/modules/inventory/transfer-posting.ts', 'utf8');
  const catalog = readFileSync('src/ui/shell/screen-catalog.ts', 'utf8');

  it('the screen that records a unit does not pull the database driver into the browser', () => {
    expect(shell).toContain("from '@/modules/inventory/serial-status'");
    expect(shell).toContain("import type { SerialView } from '@/modules/inventory/serial-number'");
    expect(shell).not.toMatch(/import\s*\{\s*SERIAL_STATUSES[^}]*\}\s*from\s*'@\/modules\/inventory\/serial-number'/);
    // And the file it does import must not import a table or a database client of its own.
    expect(statuses).not.toContain("from './schema'");
    expect(statuses).not.toContain("from '../../platform/db/client'");
    expect(statuses).not.toContain('import {');
    // The module reads the statuses from that file rather than keeping a second copy that could drift.
    expect(module_).toContain("from './serial-status'");
  });

  it('names the four statuses, and says what each of them means', () => {
    for (const status of ['AVAILABLE', 'IN_STOCK', 'DELIVERED', 'SCRAPPED']) {
      expect(statuses, status).toContain(`'${status}'`);
    }
    // Rendered, not merely held: a clerk reading DELIVERED is entitled to be told it means the
    // delivery it went on is written beside it.
    expect(shell).toContain('SERIAL_STATUS_MEANING[row.status]');
  });

  it('only a material counted in serials is asked', () => {
    expect(delivery).toContain('serialised.get(line.materialNumber)');
    expect(delivery).toContain('serialManaged: material.serialManaged');
    // And the switch lives on the material master, which is the only place the question is asked.
    expect(readFileSync('src/modules/inventory/schema.ts', 'utf8')).toContain('serialManaged');
  });

  it('a pick has to say which units, and say all of them', () => {
    expect(module_).toContain('serials.length !== wanted');
    // Not "at least" and not "up to": naming two for three leaves one unaccounted for, and the only
    // honest answer to "which one" is the one the picker did not give.
    expect(module_).toContain('Name all ${wanted}');
    expect(delivery).toContain('serialNumbers: z.array(z.string().trim().max(40)).optional()');
  });

  it('one unit goes out once', () => {
    expect(module_).toContain("row.status === 'DELIVERED'");
    expect(module_).toContain('has already gone out on delivery');
    // A unit created and not put away is not on a shelf, and a scrapped unit is not coming back.
    expect(module_).toContain("row.status === 'SCRAPPED'");
    expect(module_).toContain('not standing in a store');
    // The same unit named twice on one pick is the same refusal seen from the other end.
    expect(module_).toContain('named twice');
  });

  it('goods that came back are goods that never went', () => {
    // Put back in stock with nothing written against them — not "delivered and returned".
    expect(module_).toContain("status: 'IN_STOCK'");
    expect(module_).toContain("deliveryNumber: '',");
    expect(module_).toContain("customerNumber: '',");
    // And a correction has to say which units: putting them back by number alone would leave the
    // master claiming a customer holds units it does not hold.
    expect(module_).toContain('this correction takes back');
  });

  it('the master records where a unit stands, and which customer holds it', () => {
    expect(module_).toContain('customerNumber: input.customerNumber');
    expect(module_).toContain('deliveryNumber: input.deliveryNumber');
    // A delivered unit with no delivery written against it has lost one, not recorded one.
    expect(module_).toContain('cannot be recorded as delivered');
  });

  it('the screen is registered, and the transfer posting no longer claims there is no master', () => {
    expect(catalog).toContain('id: "/inventory/serial-numbers"');
    expect(catalog).toContain('code: "INV.SERIAL.MAINTAIN"');
    expect(actions).toContain('SERIAL_CAPABILITY');
    // The master exists now, so the refusal has to say what is actually missing: a transfer moves a
    // quantity, and there is nowhere on the form to name which units moved.
    expect(transfer).not.toContain('canon carries no serial-number master');
    expect(transfer).toContain('a transfer posting does not capture them');
  });
});
