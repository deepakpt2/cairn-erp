import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { checkOrderAvailability } from '../src/modules/production/order-availability';
import { co09AvailabilityFixture } from '../scripts/browser-smoke/co09-availability';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

/**
 * The production order is the document the whole cycle hangs from: its number comes from a
 * range, its type has to stand before it is saved, its components are a snapshot fixed at
 * that save, and the save records a change document. The order service is the only writer
 * that does those four things, so the tree is pinned to it — `src` here, and
 * `tests/production-order-type-assignment.test.ts` for the order-type slice.
 *
 * A pin that only forbids is half a rule: the browser fixture that tripped it had to be
 * shown to build the same state on the supported writers instead. So this file pins the
 * prohibition and then builds the fixture it prohibits, and asks the check the same questions
 * the browser asks. If a later change puts a hand-written order row back into `scripts`,
 * the first test refuses; if it instead deletes the fixture leg that needs one, the second
 * refusal is that the state no longer stands.
 */
const ORDER_INSERT = /insert\s+into\s+production_order\b|insert\(productionOrder\)/;
const ORDER_WRITE = /update\s+production_order\b|delete\s+from\s+production_order\b/;

function filesUnder(dir: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.(ts|tsx|sql)$/.test(name)) continue;
      if (pattern.test(readFileSync(path, 'utf8'))) hits.push(path);
    }
  };
  walk(dir);
  return hits.sort();
}

describe('production order writers', () => {
  it('leaves the order table to the order service in the application', () => {
    expect(filesUnder('src', ORDER_INSERT)).toEqual(['src/modules/inventory/production-orders.ts']);
  });

  it('keeps the scripts beside the application off the order table in either direction', () => {
    expect(filesUnder('scripts', ORDER_INSERT)).toEqual([]);
    expect(filesUnder('scripts', ORDER_WRITE)).toEqual([]);
  });

  describe('the CO09 browser fixture', () => {
    let tenant: TestTenant;

    beforeAll(async () => {
      tenant = await createTenant('co09fix');
    }, 180_000);

    afterAll(async () => {
      await destroyTenant(tenant.client);
      await closeDb();
    }, 180_000);

    it('makes the order the check reads by planning and converting it', async () => {
      const fixture = await co09AvailabilityFixture(tenant.client);
      expect(fixture.order).toBeTruthy();
      expect(fixture.orderUncontrolled).toBeTruthy();
      expect(fixture.order).not.toBe(fixture.orderUncontrolled);

      const headers = await withTenant(tenant.client, (tx) => tx.execute(sql`
        select order_number, status, version, order_type, material_number, plant,
               production_version, bom_usage, bom_alternative,
               (planned_order_number is not null) as from_conversion
          from production_order
         where client = ${tenant.client}
         order by order_number
      `)) as unknown as Array<Record<string, unknown>>;
      expect(headers).toHaveLength(2);
      const checked = headers.find((row) => row.order_number === fixture.order);
      const uncontrolled = headers.find((row) => row.order_number === fixture.orderUncontrolled);
      // Version 2 is the fixture's own component addition. Nothing else has touched either
      // order: no release, and no hand-set status.
      expect(checked).toMatchObject({
        status: 'CREATED', version: 2, order_type: 'PP01', material_number: 'CO09-GOOD',
        plant: 'QG01', production_version: 'V01', bom_usage: 'P', bom_alternative: '01',
        from_conversion: true,
      });
      expect(uncontrolled).toMatchObject({
        status: 'CREATED', version: 1, order_type: 'PP02', material_number: 'CO09-OTHER',
        from_conversion: true,
      });

      const components = await withTenant(tenant.client, (tx) => tx.execute(sql`
        select order_number, item_number, material_number, required_quantity::text as required_quantity,
               unit_of_measure, bom_item, source_material, requirement_date::text as requirement_date
          from production_order_component
         where client = ${tenant.client}
         order by order_number, item_number
      `)) as unknown as Array<Record<string, unknown>>;
      const onChecked = components.filter((row) => row.order_number === fixture.order);
      expect(onChecked.map((row) => [
        row.item_number, row.material_number, row.required_quantity, row.bom_item, row.requirement_date,
      ])).toEqual([
        [10, 'CO09-PART', '20.000', '0010', fixture.requirementDay],
        [20, 'CO09-BULK', '3.000', '0020', fixture.requirementDay],
        [30, 'CO09-FREE', '7.000', '0030', fixture.requirementDay],
        // The line the bill does not carry: added by the change screen, so no bill identity
        // and nothing to copy a date from.
        [40, 'CO09-NONE', '6.000', null, null],
      ]);
      expect(components.filter((row) => row.order_number === fixture.orderUncontrolled)).toEqual([
        expect.objectContaining({
          item_number: 10, material_number: 'CO09-PART', required_quantity: '2.000',
          requirement_date: fixture.requirementDay,
        }),
      ]);

      // The four answers the browser target reads off the table, asked of the service.
      const view = await checkOrderAvailability({
        client: tenant.client, orderNumber: fixture.order, today: fixture.requirementDay,
      });
      expect(view.components.map((row) => [row.itemNumber, row.outcome, row.cumulatedAtp, row.coveredQuantity])).toEqual([
        ['10', 'AVAILABLE', 34, 20],
        ['20', 'EXCLUDED', null, null],
        ['30', 'NO_GROUP', null, null],
        ['40', 'UNDATED', null, null],
      ]);

      // The second order stands on a type with no checking control, which is a refusal
      // rather than an answer of zero.
      const other = await checkOrderAvailability({
        client: tenant.client, orderNumber: fixture.orderUncontrolled, today: fixture.requirementDay,
      });
      expect(other.status).not.toBe('CHECKED');
      expect(other.components.every((row) => row.cumulatedAtp === null)).toBe(true);
    }, 300_000);
  });
});
