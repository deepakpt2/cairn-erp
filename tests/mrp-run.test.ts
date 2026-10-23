import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { MrpRunError, getMrpRun, planMaterials } from '../src/modules/production/mrp-run';
import { stockRequirementsList } from '../src/modules/production/stock-requirements';
import { createTenant, destroyTenant } from './helpers';

/**
 * SCR-166 / MD01 — a run calculates a shortage and posts nothing.
 *
 * The planning file is the net-change marker. A buy shortage becomes a purchase
 * requisition. A make shortage becomes a planned order. A future receipt does
 * not cover an earlier shortage. A check writes nothing.
 */
describe('SCR-166 total planning (MD01)', () => {
  const ACTOR = 'SCR166_PLANNER';
  const PLANT = '1000';
  const DAY = '2026-10-22';
  let client = '';
  let other = '';
  let key = 0;
  const nextKey = () => `scr166-${++key}`;

  async function fingerprint(): Promise<string> {
    return withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*) from material_document where client = ${client})::int as documents,
          (select count(*) from journal_entry where client = ${client})::int as journals,
          (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${client}) as stock,
          (select count(*) from production_order where client = ${client})::int as orders
      `) as unknown as Array<{ documents: number; journals: number; stock: string; orders: number }>;
      const row = rows[0]!;
      return `${row.documents}/${row.journals}/${row.stock}/${row.orders}`;
    });
  }

  async function material(number: string, values: {
    type?: string; procurement?: string; lot?: string; fixed?: string; safety?: string; reorder?: string;
    delivery?: number; production?: number; group?: string | null; netChange?: boolean;
  }) {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${client}, ${number}, ${number}, t.material_type, 'PC', ${ACTOR}
          from (select material_type from material_type where client = ${client} order by material_type limit 1) t
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (
          client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
          fixed_lot_size, safety_stock, reorder_point, planned_delivery_days, in_house_production_days,
          purchasing_group, mrp_status, created_by
        ) values (
          ${client}, ${number}, ${PLANT}, ${values.type ?? 'REQUIREMENTS'}, '001', ${values.procurement ?? 'BUY'},
          ${values.lot ?? 'EXACT'}, ${values.fixed ?? '0'}, ${values.safety ?? '0'}, ${values.reorder ?? '0'},
          ${values.delivery ?? 0}, ${values.production ?? 0}, ${values.group === undefined ? '001' : values.group},
          'MAINTAINED', ${ACTOR}
        )
        on conflict (client, material_number, plant) do update set
          mrp_type = excluded.mrp_type, procurement_type = excluded.procurement_type, lot_sizing = excluded.lot_sizing,
          fixed_lot_size = excluded.fixed_lot_size, safety_stock = excluded.safety_stock,
          reorder_point = excluded.reorder_point, planned_delivery_days = excluded.planned_delivery_days,
          in_house_production_days = excluded.in_house_production_days, purchasing_group = excluded.purchasing_group,
          mrp_status = 'MAINTAINED'
      `);
      if (values.netChange !== undefined) {
        await tx.execute(sql`
          insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
          values (${client}, ${number}, ${PLANT}, ${values.netChange}, 'Test', ${ACTOR})
          on conflict (client, material_number, plant) do update set net_change = excluded.net_change, last_changed_at = now()
        `);
      }
    });
  }

  beforeAll(async () => {
    const tenant = await createTenant('scr166-md01');
    client = tenant.client;
    const second = await createTenant('scr166-md01-other');
    other = second.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'MRPRUN', subObject: '*', prefix: 'MR', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PLANORD', subObject: '*', prefix: 'PL', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR });
    });
  });

  afterAll(async () => {
    await destroyTenant(client);
    await destroyTenant(other);
  });

  it('refuses a batch path and an MRP area by name, and writes nothing', async () => {
    const before = await fingerprint();
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      named: { mrpArea: '0001' },
    })).rejects.toThrow(/MRP area does not stand/);
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      named: { bom: 'BOM-1' },
    })).rejects.toThrow(/does not explode a bill of material/);
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      planningMode: 'DELETE_AND_RECREATE',
    })).rejects.toThrow(/Delete and recreate is not this planning mode/);
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      named: { period: '2026' },
    })).rejects.toThrow(/financial period is not read/);
    expect(await fingerprint()).toBe(before);
  });

  it('does not propose when stock covers safety, and does not treat zero stock alone as a shortage', async () => {
    await material('MD01-COVERED', { safety: '10', netChange: true });
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'MD01-COVERED', ${PLANT}, '0001', 'UNRESTRICTED', 10, ${ACTOR})
        on conflict do nothing
      `);
    });
    const covered = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-COVERED', materialTo: 'MD01-COVERED',
    });
    expect(covered.proposalsCreated).toBe(0);
    expect(covered.materials[0]?.message).toMatch(/No shortage/);

    await material('MD01-ZERO', { safety: '0', netChange: true });
    const zero = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-ZERO', materialTo: 'MD01-ZERO',
    });
    expect(zero.proposals).toHaveLength(0);
  });

  it('plans a buy shortage against safety stock, and a future receipt does not cover today', async () => {
    await material('MD01-BUY', { safety: '10', delivery: 2, netChange: true });
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'MD01-BUY', ${PLANT}, '0001', 'UNRESTRICTED', 4, ${ACTOR}),
               (${client}, 'MD01-BUY', ${PLANT}, '0001', 'BLOCKED', 9, ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchase_requisition_item (
          client, requisition_number, item_number, short_text, quantity, unit, requisition_date, delivery_date,
          plant, purchasing_group, material_number, created_by
        ) values (
          ${client}, 'PR-MANUAL1', 10, 'Later receipt', 6, 'PC', ${DAY}, '2099-01-01', ${PLANT}, '001', 'MD01-BUY', ${ACTOR}
        )
      `);
    });
    const before = await fingerprint();
    const run = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-BUY', materialTo: 'MD01-BUY',
    });
    expect(run.proposalsCreated).toBe(1);
    expect(run.proposals[0]?.proposalType).toBe('PURCHASE_REQUISITION');
    expect(run.proposals[0]?.quantity).toBe('6.000');
    expect(run.proposals[0]?.startDate < run.proposals[0]!.receiptDate).toBe(true);
    expect(run.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(run.diagnostics.some((row) => row.diagnosticCode === 'LATE_PROPOSAL')).toBe(true);
    expect(await fingerprint()).toBe(before);
    const list = await stockRequirementsList({ client, today: DAY, selection: { material: 'MD01-BUY', plant: PLANT } });
    const requisitions = list.rows.filter((row) => row.elementType === 'PURCHASE_REQUISITION');
    expect(requisitions).toHaveLength(2);
  });

  it('checks without writing a requisition or clearing the planning file', async () => {
    await material('MD01-CHECK', { safety: '5', netChange: true });
    const run = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-CHECK', materialTo: 'MD01-CHECK', simulationOnly: true,
    });
    expect(run.simulationOnly).toBe(true);
    expect(run.proposals[0]?.status).toBe('PROPOSED');
    expect(run.proposalsCreated).toBe(0);
    const file = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select net_change from planning_file
         where client = ${client} and material_number = 'MD01-CHECK' and plant = ${PLANT}
      `) as unknown as Array<{ net_change: boolean }>;
      return rows[0]?.net_change;
    });
    expect(file).toBe(true);
    const count = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_item
         where client = ${client} and material_number = 'MD01-CHECK'
      `) as unknown as Array<{ count: number }>;
      return rows[0]?.count;
    });
    expect(count).toBe(0);
  });

  it('replays the same request and refuses a different one', async () => {
    await material('MD01-REPLAY', { safety: '3', netChange: true });
    const key = nextKey();
    const first = await planMaterials({
      client, requestedBy: ACTOR, requestKey: key, processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-REPLAY', materialTo: 'MD01-REPLAY',
    });
    const again = await planMaterials({
      client, requestedBy: ACTOR, requestKey: key, processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-REPLAY', materialTo: 'MD01-REPLAY',
    });
    expect(again.runNumber).toBe(first.runNumber);
    expect(again.proposalsCreated).toBe(first.proposalsCreated);
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: key, processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-ZERO', materialTo: 'MD01-ZERO',
    })).rejects.toThrow(/different scope/);
  });

  it('adapts an eligible proposal and does not rewrite a changed one', async () => {
    await material('MD01-ADAPT', { safety: '4', netChange: true });
    const first = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-ADAPT', materialTo: 'MD01-ADAPT',
    });
    const number = first.proposals[0]?.documentNumber;
    expect(number).toBeTruthy();
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update material_plant set safety_stock = 7
         where client = ${client} and material_number = 'MD01-ADAPT' and plant = ${PLANT}
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${client} and material_number = 'MD01-ADAPT' and plant = ${PLANT}
      `);
    });
    const second = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-ADAPT', materialTo: 'MD01-ADAPT',
    });
    expect(second.proposalsChanged).toBe(1);
    expect(second.proposals[0]?.documentNumber).toBe(number);
    expect(second.proposals[0]?.quantity).toBe('7.000');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        update purchase_requisition_item set quantity = 99
         where client = ${client} and requisition_number = ${number}
      `);
      await tx.execute(sql`
        update material_plant set safety_stock = 8
         where client = ${client} and material_number = 'MD01-ADAPT' and plant = ${PLANT}
      `);
      await tx.execute(sql`
        update planning_file set net_change = true, last_changed_at = now()
         where client = ${client} and material_number = 'MD01-ADAPT' and plant = ${PLANT}
      `);
    });
    const third = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-ADAPT', materialTo: 'MD01-ADAPT',
    });
    expect(third.proposals.some((row) => row.action === 'CONFLICT')).toBe(true);
    const standing = await withTenant(client, async (tx) => {
      const rows = await tx.execute(sql`
        select quantity::text as quantity from purchase_requisition_item
         where client = ${client} and requisition_number = ${number}
      `) as unknown as Array<{ quantity: string }>;
      return rows[0]?.quantity;
    });
    expect(standing).toBe('99.000');
  });

  it('creates a planned order for make, and the live list shows it once', async () => {
    await material('MD01-MAKE', { procurement: 'MAKE', safety: '5', production: 3, netChange: true });
    const before = await fingerprint();
    const run = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-MAKE', materialTo: 'MD01-MAKE',
    });
    expect(run.proposals[0]?.proposalType).toBe('PLANNED_ORDER');
    expect(run.proposals[0]?.quantity).toBe('5.000');
    expect(await fingerprint()).toBe(before);
    const list = await stockRequirementsList({ client, today: DAY, selection: { material: 'MD01-MAKE', plant: PLANT } });
    const planned = list.rows.filter((row) => row.elementType === 'PLANNED_ORDER');
    expect(planned).toHaveLength(1);
    expect(planned[0]?.quantity).toBe(5);
  });

  it('uses the reorder point rather than safety stock, and raises a fixed lot', async () => {
    await material('MD01-REORDER', {
      type: 'REORDER', safety: '20', reorder: '10', lot: 'FIXED', fixed: '10', netChange: true,
    });
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${client}, 'MD01-REORDER', ${PLANT}, '0001', 'UNRESTRICTED', 4, ${ACTOR})
        on conflict do nothing
      `);
    });
    const run = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-REORDER', materialTo: 'MD01-REORDER',
    });
    expect(run.proposals[0]?.quantity).toBe('10.000');
  });

  it('skips an unchanged material on net change, and refuses regenerative planning without confirmation', async () => {
    await material('MD01-STILL', { safety: '9', netChange: false });
    const skipped = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-STILL', materialTo: 'MD01-STILL',
    });
    expect(skipped.materialsSelected).toBe(0);
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NEUPL', plantFrom: PLANT,
      materialFrom: 'MD01-STILL', materialTo: 'MD01-STILL',
    })).rejects.toThrow(/needs confirmation/);
    const regenerative = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NEUPL', plantFrom: PLANT,
      materialFrom: 'MD01-STILL', materialTo: 'MD01-STILL', confirmRegenerative: true,
    });
    expect(regenerative.materialsSelected).toBe(1);
    expect(regenerative.proposalsCreated).toBe(1);
  });

  it('does not treat a missing planning file as a complete net-change run', async () => {
    await material('MD01-NOFILE', { safety: '2' });
    await expect(planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-NOFILE', materialTo: 'MD01-NOFILE',
    })).rejects.toThrow(/no planning file/);
  });

  it('leaves the other tenant with nothing', async () => {
    const run = await planMaterials({
      client, requestedBy: ACTOR, requestKey: nextKey(), processingKey: 'NETCH', plantFrom: PLANT,
      materialFrom: 'MD01-COVERED', materialTo: 'MD01-COVERED',
    });
    expect(await getMrpRun(other, run.runNumber)).toBeNull();
  });
});
