import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import {
  RequisitionListError,
  listPurchaseRequisitions,
  type RequisitionListSelection,
} from '../src/modules/purchasing/requisition-list';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-123 / ME5A acceptance for PROC.REQ.LIST.
 *
 * The list adds no state: it reads the standing requisition items, derives the
 * purchasing organisations through the plant assignment, and derives the
 * conversion status from the live purchase-order items that cite each
 * requisition line. The suite pins the contract's decisions — org derivation
 * with an unmapped plant still visible, OPEN/PARTIAL/CONVERTED with the open
 * quantity floored at zero, deletion marks closing an item and stopping a PO
 * line from converting it, the closed toggle, and refusal by name for a range
 * endpoint that does not stand.
 */
describe('SCR-123 purchase requisition list (ME5A)', () => {
  const ACTOR = 'SCR123_ME5A_TEST';
  let client = '';

  beforeAll(async () => {
    const tenant = await createTenant('scr123-me5a-list');
    client = tenant.client;
    await withTenant(client, async (tx) => {
      // Masters: three plants (P230 deliberately carries no purchasing org),
      // two organisations, two groups, two materials, one supplier.
      await tx.execute(sql`
        insert into plant (client, plant, name, country, created_by) values
          (${client}, 'P210', 'Plant 210', 'KW', ${ACTOR}),
          (${client}, 'P220', 'Plant 220', 'KW', ${ACTOR}),
          (${client}, 'P230', 'Plant 230', 'KW', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, created_by) values
          (${client}, 'O210', 'Org 210', ${ACTOR}),
          (${client}, 'O220', 'Org 220', ${ACTOR}),
          (${client}, 'O230', 'Org 230', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org_plant (client, purchasing_org, plant, created_by) values
          (${client}, 'O210', 'P210', ${ACTOR}),
          (${client}, 'O220', 'P210', ${ACTOR}),
          (${client}, 'O220', 'P220', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, created_by) values
          (${client}, 'G01', 'Group 01', ${ACTOR}),
          (${client}, 'G02', 'Group 02', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by) values
          (${client}, 'M100', 'Material 100', 'RAW', 'PC', ${ACTOR}),
          (${client}, 'M200', 'Material 200', 'RAW', 'PC', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, name, created_by)
        values (${client}, 'V90000', 'List supplier', ${ACTOR}) on conflict do nothing
      `);

      // Requisition items. 001 OPEN, 002 PARTIAL, 003 CONVERTED, 004 marked,
      // 005 over-converted (open floored at zero), 006 cost-centre assigned.
      await tx.execute(sql`
        insert into purchase_requisition_item (
          client, requisition_number, item_number, document_type, item_category,
          account_assignment_category, material_number, short_text, quantity, unit,
          requisition_date, delivery_date, plant, purchasing_group,
          estimated_price, price_unit, currency, marked_for_deletion, creation_source, created_by
        ) values
          (${client}, '9000000001', 10, 'STANDARD', 'STANDARD', null, 'M100', 'Open line', 10, 'PC',
           '2026-03-10', '2026-04-10', 'P210', 'G01', 12.50, 1, 'USD', false, 'MANUAL', 'ALICE'),
          (${client}, '9000000002', 10, 'STANDARD', 'STANDARD', null, 'M200', 'Partial line', 10, 'PC',
           '2026-03-11', '2026-04-11', 'P220', 'G02', 5.00, 1, 'USD', false, 'MANUAL', 'BOB'),
          (${client}, '9000000003', 10, 'STANDARD', 'STANDARD', null, 'M100', 'Converted line', 5, 'PC',
           '2026-03-12', '2026-04-12', 'P210', 'G01', 1.00, 1, 'USD', false, 'MANUAL', 'ALICE'),
          (${client}, '9000000004', 10, 'STANDARD', 'STANDARD', null, null, 'Deleted line', 5, 'PC',
           '2026-03-13', '2026-04-13', 'P230', 'G02', 1.00, 1, 'USD', true, 'MANUAL', 'ALICE'),
          (${client}, '9000000005', 10, 'STANDARD', 'STANDARD', null, null, 'Over-converted line', 2, 'PC',
           '2026-03-16', '2026-04-16', 'P230', 'G01', 1.00, 1, 'USD', false, 'MANUAL', 'BOB'),
          (${client}, '9000000006', 10, 'STANDARD', 'STANDARD', 'COST_CENTER', null, 'Cost centre line', 8, 'PC',
           '2026-03-15', '2026-04-15', 'P210', 'G02', 3.00, 1, 'USD', false, 'MANUAL', 'ALICE')
        on conflict do nothing
      `);

      // Live conversions: 002 partially, 003 fully, 005 over, plus one PO line
      // on 001 that is marked for deletion and must not convert it.
      await tx.execute(sql`
        insert into purchase_order (
          client, order_number, document_type, supplier_number, purchasing_org,
          purchasing_group, company_code, currency, document_date, release_status, created_by
        ) values
          (${client}, 'PO90000001', 'STANDARD', 'V90000', 'O220', 'G02', '1000', 'USD', '2026-03-11', 'RELEASED', ${ACTOR}),
          (${client}, 'PO90000002', 'STANDARD', 'V90000', 'O210', 'G01', '1000', 'USD', '2026-03-12', 'RELEASED', ${ACTOR}),
          (${client}, 'PO90000003', 'STANDARD', 'V90000', 'O230', 'G01', '1000', 'USD', '2026-03-16', 'RELEASED', ${ACTOR}),
          (${client}, 'PO90000004', 'STANDARD', 'V90000', 'O210', 'G01', '1000', 'USD', '2026-03-10', 'RELEASED', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_order_item (
          client, order_number, item_number, item_category, material_number, short_text,
          quantity, unit, net_price, price_unit, net_value, plant,
          requisition_number, requisition_item, marked_for_deletion, created_by
        ) values
          (${client}, 'PO90000001', 10, 'STANDARD', 'M200', 'Partial order', 4, 'PC', 5, 1, 20, 'P220', '9000000002', 10, false, ${ACTOR}),
          (${client}, 'PO90000002', 10, 'STANDARD', 'M100', 'Full order', 5, 'PC', 1, 1, 5, 'P210', '9000000003', 10, false, ${ACTOR}),
          (${client}, 'PO90000003', 10, 'STANDARD', null, 'Over order', 5, 'PC', 1, 1, 5, 'P230', '9000000005', 10, false, ${ACTOR}),
          (${client}, 'PO90000004', 10, 'STANDARD', 'M100', 'Deleted order', 10, 'PC', 1, 1, 10, 'P210', '9000000001', 10, true, ${ACTOR})
        on conflict do nothing
      `);
    });
  });

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function list(selection: Partial<RequisitionListSelection>) {
    return listPurchaseRequisitions({ client, selection: { displayClosed: false, maxHits: 100, ...selection } });
  }

  it('hides closed requisitions by default and reports why', async () => {
    const result = await list({});
    const numbers = result.rows.map((r) => r.requisitionNumber);
    // 9000000005 is over-converted, so it counts as closed and stays hidden.
    expect(numbers).toEqual(['9000000006', '9000000002', '9000000001']);
    expect(numbers).not.toContain('9000000003');
    expect(numbers).not.toContain('9000000004');
    expect(result.closedHidden).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/Closed requisitions/);
  });

  it('derives organisations through the plant and keeps an unmapped plant visible', async () => {
    const result = await list({ displayClosed: true });
    const byNumber = new Map(result.rows.map((r) => [r.requisitionNumber, r]));
    expect(byNumber.get('9000000001')?.purchasingOrgs).toEqual(['O210', 'O220']);
    expect(byNumber.get('9000000002')?.purchasingOrgs).toEqual(['O220']);
    expect(byNumber.get('9000000005')?.purchasingOrgs).toEqual([]);
  });

  it('derives OPEN, PARTIAL and CONVERTED from live order items, flooring open at zero', async () => {
    const result = await list({ displayClosed: true });
    const byNumber = new Map(result.rows.map((r) => [r.requisitionNumber, r]));
    expect(byNumber.get('9000000001')).toMatchObject({ status: 'OPEN', orderedQuantity: 0, openQuantity: 10 });
    expect(byNumber.get('9000000002')).toMatchObject({ status: 'PARTIAL', orderedQuantity: 4, openQuantity: 6 });
    expect(byNumber.get('9000000003')).toMatchObject({ status: 'CONVERTED', orderedQuantity: 5, openQuantity: 0 });
    expect(byNumber.get('9000000005')).toMatchObject({ status: 'CONVERTED', orderedQuantity: 5, openQuantity: 0 });
  });

  it('counts a marked requisition as closed and a marked order line as not converting', async () => {
    const result = await list({ displayClosed: true });
    const byNumber = new Map(result.rows.map((r) => [r.requisitionNumber, r]));
    expect(byNumber.get('9000000004')).toMatchObject({ closed: true, markedForDeletion: true });
    // PO90000004/10 (10 PC) is marked for deletion, so 9000000001 stays open.
    expect(byNumber.get('9000000001')?.orderedQuantity).toBe(0);
  });

  it('filters by plant, group, material, date, requisitioner and account assignment', async () => {
    const byPlant = await list({ plantFrom: 'P210', plantTo: 'P210' });
    expect(byPlant.rows.map((r) => r.requisitionNumber).sort()).toEqual(['9000000001', '9000000006']);

    const byGroup = await list({ purchasingGroupFrom: 'G02', purchasingGroupTo: 'G02' });
    expect(byGroup.rows.map((r) => r.requisitionNumber).sort()).toEqual(['9000000002', '9000000006']);

    const byMaterial = await list({ materialFrom: 'M100', materialTo: 'M100' });
    expect(byMaterial.rows.map((r) => r.requisitionNumber)).toEqual(['9000000001']);

    const byDate = await list({ requisitionDateFrom: '2026-03-11', requisitionDateTo: '2026-03-15' });
    expect(byDate.rows.map((r) => r.requisitionNumber).sort()).toEqual(['9000000002', '9000000006']);

    const byPerson = await list({ requisitioner: 'BOB' });
    expect(byPerson.rows.map((r) => r.requisitionNumber).sort()).toEqual(['9000000002']);

    const costCentre = await list({ accountAssignmentCategory: 'COST_CENTER' });
    expect(costCentre.rows.map((r) => r.requisitionNumber)).toEqual(['9000000006']);

    const unassigned = await list({ accountAssignmentCategory: 'NONE' });
    expect(unassigned.rows.map((r) => r.requisitionNumber)).not.toContain('9000000006');
  });

  it('matches a purchasing organisation through any plant assignment', async () => {
    const org210 = await list({ purchasingOrgFrom: 'O210', purchasingOrgTo: 'O210' });
    // P210 carries O210 and O220; P220 carries O220 and P230 carries none.
    expect(org210.rows.map((r) => r.requisitionNumber).sort()).toEqual(['9000000001', '9000000006']);

    const org220 = await list({ purchasingOrgFrom: 'O220', purchasingOrgTo: 'O220' });
    expect(org220.rows.map((r) => r.requisitionNumber).sort()).toEqual(['9000000001', '9000000002', '9000000006']);
  });

  it('truncates at the maximum hits and says so', async () => {
    const result = await list({ maxHits: 2 });
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.maxHits).toBe(2);
    expect(result.warnings.join(' ')).toMatch(/truncated at 2 hits/);
  });

  it('refuses a range endpoint that does not stand, by name', async () => {
    await expect(list({ plantFrom: 'P999' })).rejects.toThrow(/plant P999/);
    await expect(list({ purchasingGroupTo: 'GZZ' })).rejects.toThrow(/purchasing group GZZ/);
    await expect(list({ purchasingOrgFrom: 'OZZZ' })).rejects.toThrow(/purchasing organisation OZZZ/);
    await expect(list({ materialFrom: 'MZZZ' })).rejects.toThrow(/material MZZZ/);
    await expect(list({ requisitioner: 'NOBODY' })).rejects.toThrow(/Requisitioner NOBODY/);
    await expect(list({ accountAssignmentCategory: 'ORDER' })).rejects.toThrow(/ORDER/);
    await expect(list({ plantFrom: 'P230', plantTo: 'P210' })).rejects.toThrow(/inverted/);
    await expect(list({ requisitionDateFrom: '2026-02-30' })).rejects.toThrow(/not a valid date/);
    await expect(list({ maxHits: 0 })).rejects.toThrow(/Maximum hits/);
    await expect(list({ plantFrom: 'P999' })).rejects.toBeInstanceOf(RequisitionListError);
  });

  it('drills each row down to the ME53N-equivalent display', async () => {
    const result = await list({});
    for (const row of result.rows) {
      expect(row.drillDown).toBe(`/purchasing/requisitions?req=${row.requisitionNumber}`);
    }
    expect(result.capability).toBe('PROC.REQ.LIST');
  });
});
