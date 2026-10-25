import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createRequisition, changeRequisition, getRequisition } from '../src/modules/purchasing/requisitions';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'PR_TX_STAGE1';

describe('requisition transaction ownership', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  const item = {
    shortText: 'Transaction plate',
    quantity: 10,
    unit: 'PC',
    deliveryDate: '2026-11-15',
    plant: '1000',
    purchasingGroup: '001',
  };

  beforeAll(async () => {
    tenant = await createTenant('pr-tx-stage1');
    other = await createTenant('pr-tx-stage1-other');
    await withTenant(tenant.client, (tx) => defineRange(tx, {
      client: tenant.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR,
    }));
    await withTenant(other.client, (tx) => defineRange(tx, {
      client: other.client, objectCode: 'PURCHREQ', subObject: 'NB', prefix: 'PR', numberLength: 7, createdBy: ACTOR,
    }));
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, created_by)
        select ${tenant.client}, controlling_area, 'CC1000', '2020-01-01', '2099-12-31', 'Test cost centre', 'ADMINISTRATION', '1000', ${ACTOR}
          from controlling_area_company
         where client = ${tenant.client} and company_code = '1000'
        on conflict do nothing
      `);
    });
  });

  async function footprint(client: string, requisitionNumber: string) {
    return withTenant(client, async (tx) => {
      const [range] = await tx.execute(sql`
        select current_number::text as current_number
          from number_range
         where client = ${client} and object_code = 'PURCHREQ' and company_code = '*'
           and sub_object = 'NB' and fiscal_year = 0
      `) as unknown as Array<{ current_number: string }>;
      const [alloc] = await tx.execute(sql`
        select count(*)::int as count from number_range_allocation
         where client = ${client} and object_code = 'PURCHREQ' and sub_object = 'NB'
           and displayed_number = ${requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      const [items] = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_item
         where client = ${client} and requisition_number = ${requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      const [assignments] = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_assignment
         where client = ${client} and requisition_number = ${requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      const [changes] = await tx.execute(sql`
        select count(*)::int as count from change_document
         where client = ${client} and object_class = 'purchase_requisition' and object_key = ${requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      const [changeItems] = await tx.execute(sql`
        select count(*)::int as count
          from change_document_item i
          join change_document d on d.id = i.change_document_id and d.client = i.client
         where d.client = ${client} and d.object_class = 'purchase_requisition' and d.object_key = ${requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      const [releases] = await tx.execute(sql`
        select count(*)::int as count from document_release
         where client = ${client} and document_category = 'PURCHASE_REQUISITION'
           and document_number = ${requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      return {
        currentNumber: range?.current_number,
        allocations: alloc?.count ?? 0,
        items: items?.count ?? 0,
        assignments: assignments?.count ?? 0,
        changes: changes?.count ?? 0,
        changeItems: changeItems?.count ?? 0,
        releases: releases?.count ?? 0,
      };
    });
  }

  afterAll(async () => {
    await destroyTenant(tenant.client);
    await destroyTenant(other.client);
    await closeDb();
  });

  it('uses the material-step handle in planning and leaves the screen on its own transaction', () => {
    const service = readFileSync('src/modules/purchasing/requisitions.ts', 'utf8');
    const planning = readFileSync('src/modules/production/mrp-run.ts', 'utf8');
    const actions = readFileSync('src/app/purchasing/requisitions/actions.ts', 'utf8');
    const create = service.slice(service.indexOf('export async function createRequisition'), service.indexOf('export async function changeRequisition'));
    const change = service.slice(service.indexOf('export async function changeRequisition'), service.indexOf('export interface RequisitionChoices'));
    expect(create).toContain('externalTx ? await run(externalTx) : await withTenant(input.client, run)');
    expect(change).toContain('if (externalTx) await run(externalTx)');
    expect(change).toContain('else await withTenant(input.client, run)');
    expect(create.slice(create.indexOf('const run = async'), create.indexOf('A supplied handle'))).not.toContain('withTenant');
    expect(change.slice(change.indexOf('const run = async'), change.indexOf('A supplied handle'))).not.toContain('withTenant');
    expect(change).toContain('pg_advisory_xact_lock');
    const callOf = (source: string, name: string) => source.slice(source.indexOf(`await ${name}(`), source.indexOf(');', source.indexOf(`await ${name}(`)));
    const created = callOf(planning, 'createRequisition');
    const changed = callOf(planning, 'changeRequisition');
    expect(created).toMatch(/,\s*tx$/);
    expect(changed).toMatch(/,\s*tx$/);
    expect(created).not.toContain('withTenant');
    expect(changed).not.toContain('withTenant');
    expect(actions).toContain('await createRequisition(base);');
    expect(actions).toContain('await changeRequisition({ ...base, requisitionNumber })');
    expect(actions).not.toContain('createRequisition(base,');
    expect(actions).not.toContain('changeRequisition({ ...base, requisitionNumber },');
  });

  it('rolls back a create and a change made on the caller transaction', async () => {
    const standing = await createRequisition({ client: tenant.client, changedBy: ACTOR, items: [item] });
    const beforeRange = await footprint(tenant.client, 'PR-NOT-YET');
    const beforeStanding = await footprint(tenant.client, standing.requisitionNumber);
    let rolled = '';
    await expect(withTenant(tenant.client, async (tx) => {
      const created = await createRequisition({
        client: tenant.client, changedBy: ACTOR,
        items: [{
          ...item,
          shortText: 'Rolled assignment',
          accountAssignmentCategory: 'COST_CENTER',
          assignments: [{ glAccount: '400000', costCenter: 'CC1000', distributionPercentage: 100 }],
        }],
      }, tx);
      rolled = created.requisitionNumber;
      const visible = await tx.execute(sql`
        select requisition_number from purchase_requisition_item
         where client = ${tenant.client} and requisition_number = ${rolled}
      `) as unknown as unknown[];
      expect(visible.length).toBe(1);
      const assigned = await tx.execute(sql`
        select count(*)::int as count from purchase_requisition_assignment
         where client = ${tenant.client} and requisition_number = ${rolled}
      `) as unknown as Array<{ count: number }>;
      expect(assigned[0]?.count).toBe(1);
      const allocated = await tx.execute(sql`
        select current_number::text as current_number from number_range
         where client = ${tenant.client} and object_code = 'PURCHREQ' and company_code = '*'
           and sub_object = 'NB' and fiscal_year = 0
      `) as unknown as Array<{ current_number: string }>;
      expect(Number(allocated[0]?.current_number)).toBe(Number(beforeRange.currentNumber) + 1);
      const history = await tx.execute(sql`
        select count(*)::int as count from change_document
         where client = ${tenant.client} and object_class = 'purchase_requisition' and object_key = ${rolled}
      `) as unknown as Array<{ count: number }>;
      expect(history[0]?.count).toBeGreaterThan(0);
      await changeRequisition({
        client: tenant.client, changedBy: ACTOR, requisitionNumber: standing.requisitionNumber,
        items: [{ ...item, itemNumber: 10, quantity: 99 }],
      }, tx);
      const changed = await tx.execute(sql`
        select quantity::text as quantity from purchase_requisition_item
         where client = ${tenant.client} and requisition_number = ${standing.requisitionNumber}
      `) as unknown as Array<{ quantity: string }>;
      expect(changed[0]?.quantity).toBe('99.000');
      const standingHistory = await tx.execute(sql`
        select count(*)::int as count from change_document
         where client = ${tenant.client} and object_class = 'purchase_requisition'
           and object_key = ${standing.requisitionNumber}
      `) as unknown as Array<{ count: number }>;
      expect(standingHistory[0]?.count).toBeGreaterThan(beforeStanding.changes);
      throw new Error('caller rollback');
    })).rejects.toThrow('caller rollback');

    const afterRolled = await footprint(tenant.client, rolled);
    const afterStanding = await footprint(tenant.client, standing.requisitionNumber);
    const afterRange = await footprint(tenant.client, 'PR-NOT-YET');
    expect(await getRequisition(tenant.client, rolled)).toBeNull();
    expect(afterRolled).toMatchObject({ allocations: 0, items: 0, assignments: 0, changes: 0, changeItems: 0, releases: 0 });
    expect(afterRange.currentNumber).toBe(beforeRange.currentNumber);
    expect((await getRequisition(tenant.client, standing.requisitionNumber))?.items[0]?.quantity).toBe('10.000');
    expect(afterStanding.changes).toBe(beforeStanding.changes);
    expect(afterStanding.changeItems).toBe(beforeStanding.changeItems);
    const reused = await createRequisition({
      client: tenant.client, changedBy: ACTOR, items: [{ ...item, shortText: 'Reused after rollback' }],
    });
    expect(reused.requisitionNumber).toBe(rolled);
  });

  it('uses the supplied transaction for an uncommitted master and rejects another tenant handle', async () => {
    await expect(withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_group (client, purchasing_group, name, is_active, created_by)
        values (${tenant.client}, 'ZTX', 'Uncommitted group', true, ${ACTOR})
      `);
      const created = await createRequisition({
        client: tenant.client, changedBy: ACTOR,
        items: [{ ...item, purchasingGroup: 'ZTX', shortText: 'Sees uncommitted group' }],
      }, tx);
      expect(created.requisitionNumber).toMatch(/^PR-/);
      throw new Error('do not commit the group');
    })).rejects.toThrow('do not commit the group');
    await expect(createRequisition({
      client: tenant.client, changedBy: ACTOR,
      items: [{ ...item, purchasingGroup: 'ZTX', shortText: 'Own transaction cannot see it' }],
    })).rejects.toThrow('Purchasing group ZTX does not exist');

    await expect(withTenant(other.client, (tx) => createRequisition({
      client: tenant.client, changedBy: ACTOR, items: [{ ...item, shortText: 'Wrong tenant handle' }],
    }, tx))).rejects.toThrow();
    const leaked = await withTenant(tenant.client, async (tx) => tx.execute(sql`
      select count(*)::int as count from purchase_requisition_item
       where client = ${tenant.client} and short_text = 'Wrong tenant handle'
    `) as unknown as Array<{ count: number }>);
    expect(leaked[0]?.count).toBe(0);
  });

  it('commits when no handle is supplied and keeps one planning-origin item', async () => {
    const committed = await createRequisition({
      client: tenant.client, changedBy: ACTOR, items: [{ ...item, shortText: 'Committed alone' }],
    });
    expect((await getRequisition(tenant.client, committed.requisitionNumber))?.items[0]?.shortText).toBe('Committed alone');
    await expect(createRequisition({
      client: tenant.client, changedBy: ACTOR, items: [{ ...item, plant: '9999' }],
    })).rejects.toThrow('Plant 9999 does not exist');

    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        select ${tenant.client}, 'PR-TX-MAT', 'Planning origin', t.material_type, 'PC', ${ACTOR}
          from (select material_type from material_type where client = ${tenant.client} order by material_type limit 1) t
      `);
      await tx.execute(sql`
        insert into material_plant (
          client, material_number, plant, mrp_type, mrp_controller, procurement_type, lot_sizing,
          fixed_lot_size, safety_stock, reorder_point, planned_delivery_days, in_house_production_days,
          purchasing_group, mrp_status, created_by
        ) values (
          ${tenant.client}, 'PR-TX-MAT', '1000', 'REQUIREMENTS', '001', 'BUY', 'EXACT',
          '0', '0', '0', 0, 0, '001', 'MAINTAINED', ${ACTOR}
        )
      `);
    });
    const origin = {
      client: tenant.client, changedBy: ACTOR, planningRunNumber: 'MRTX000001',
      items: [{ ...item, materialNumber: 'PR-TX-MAT', shortText: 'Planning origin', quantity: 4 }],
    };
    const first = await createRequisition(origin);
    const second = await createRequisition({ ...origin, items: [{ ...origin.items[0], quantity: 8 }] });
    expect(second.requisitionNumber).toBe(first.requisitionNumber);
    expect((await getRequisition(tenant.client, first.requisitionNumber))?.items[0]?.quantity).toBe('4.000');
    const sameTx = await withTenant(tenant.client, async (tx) => {
      const created = await createRequisition({
        ...origin, planningRunNumber: 'MRTX000002', items: [{ ...origin.items[0], quantity: 3 }],
      }, tx);
      const repeated = await createRequisition({
        ...origin, planningRunNumber: 'MRTX000002', items: [{ ...origin.items[0], quantity: 9 }],
      }, tx);
      return { created: created.requisitionNumber, repeated: repeated.requisitionNumber };
    });
    expect(sameTx.repeated).toBe(sameTx.created);
    expect((await getRequisition(tenant.client, sameTx.created))?.items[0]?.quantity).toBe('3.000');
  });

  it('holds the requisition advisory lock until the holder commits or rolls back', async () => {
    const locked = await createRequisition({
      client: tenant.client, changedBy: ACTOR, items: [{ ...item, shortText: 'Lock target' }],
    });
    const holderName = `pr-lock-holder-${tenant.client}`;
    const waiterName = `pr-lock-waiter-${tenant.client}`;

    async function sameAdvisoryWait(): Promise<boolean> {
      const rows = await withTenant(tenant.client, async (tx) => tx.execute(sql`
        select waiter.pid
          from pg_stat_activity wa
          join pg_locks waiter
            on waiter.pid = wa.pid and waiter.locktype = 'advisory' and not waiter.granted
          join pg_stat_activity ha on ha.application_name = ${holderName}
          join pg_locks holder
            on holder.pid = ha.pid and holder.locktype = 'advisory' and holder.granted
           and holder.classid = waiter.classid and holder.objid = waiter.objid
           and holder.objsubid = waiter.objsubid
         where wa.application_name = ${waiterName}
           and wa.wait_event_type = 'Lock'
           and wa.wait_event = 'advisory'
      `)) as unknown as unknown[];
      return rows.length > 0;
    }

    async function contend(mode: 'commit' | 'rollback', holderQty: number, waiterQty: number, committed: string) {
      expect((await getRequisition(tenant.client, locked.requisitionNumber))?.items[0]?.quantity).toBe(committed);
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let ready!: () => void;
      let failReady!: (error: unknown) => void;
      const holderReady = new Promise<void>((resolve, reject) => { ready = resolve; failReady = reject; });
      const holder = withTenant(tenant.client, async (tx) => {
        try {
          await tx.execute(sql`select set_config('application_name', ${holderName}, true)`);
          await changeRequisition({
            client: tenant.client, changedBy: ACTOR, requisitionNumber: locked.requisitionNumber,
            items: [{ ...item, itemNumber: 10, shortText: 'Lock target', quantity: holderQty }],
          }, tx);
          ready();
          await released;
          if (mode === 'rollback') throw new Error('holder rollback');
        } catch (error) {
          failReady(error);
          throw error;
        }
      });
      const holderSettled = holder.then(() => 'committed' as const, (error: unknown) => error);
      await holderReady;
      let waiterFinished = false;
      const waiter = withTenant(tenant.client, async (tx) => {
        await tx.execute(sql`select set_config('application_name', ${waiterName}, true)`);
        await changeRequisition({
          client: tenant.client, changedBy: ACTOR, requisitionNumber: locked.requisitionNumber,
          items: [{ ...item, itemNumber: 10, shortText: 'Lock target', quantity: waiterQty }],
        }, tx);
        waiterFinished = true;
      });
      const waiterSettled = waiter.then(() => 'done' as const, (error: unknown) => error);
      const deadline = Date.now() + 8000;
      let waiting = false;
      while (Date.now() < deadline) {
        if (await sameAdvisoryWait()) { waiting = true; break; }
        if (waiterFinished) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      expect(waiterFinished).toBe(false);
      expect((await getRequisition(tenant.client, locked.requisitionNumber))?.items[0]?.quantity).toBe(committed);
      release();
      const holderOutcome = await holderSettled;
      const waiterOutcome = await waiterSettled;
      if (mode === 'rollback') expect(holderOutcome).toBeInstanceOf(Error);
      else expect(holderOutcome).toBe('committed');
      expect(waiterOutcome).toBe('done');
      expect((await getRequisition(tenant.client, locked.requisitionNumber))?.items[0]?.quantity).toBe(`${waiterQty}.000`);
    }

    await contend('rollback', 21, 31, '10.000');
    await contend('commit', 41, 42, '31.000');
  });
});
