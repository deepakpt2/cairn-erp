import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY, DEMO_STRUCTURE } from '../src/platform/tenancy/demo-organisation';
import { DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The masters the provisioner builds, checked the way a person would check them.
 *
 * They are conditional on the demo standing in the database the suite runs against,
 * which is what the `cairn_dp_*` disposable databases are for. Against a database
 * where the demo has never been provisioned the tests report honestly that there is
 * nothing to check rather than passing on empty tables — a test that passes because
 * it counted nothing is worse than no test.
 */
async function demoStands(): Promise<boolean> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(
      sql`select 1 as present from client where client = ${CLIENT}`,
    )) as unknown as Array<{ present: number }>;
    return rows.length > 0;
  }).catch(() => false);
}

async function count(statement: string): Promise<number> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql.raw(statement))) as unknown as Array<{ n: number }>;
    return rows[0]?.n ?? 0;
  });
}

async function rows(statement: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(CLIENT, (tx) => tx.execute(sql.raw(statement))) as unknown as Promise<
    Array<Record<string, unknown>>
  >;
}

function mastersSource(): string {
  return readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-masters.ts'), 'utf8');
}

describe('demo masters phase', () => {
  it('appends the masters as a phase after the people, and never reorders', () => {
    expect(DEMO_PHASE_PLAN).toContain('C_MASTERS');
    // Immediately after the people: the phases run in the order they can, and
    // later phases may be appended behind this one.
    expect(DEMO_PHASE_PLAN.indexOf('C_MASTERS')).toBe(
      DEMO_PHASE_PLAN.indexOf('B_PEOPLE') + 1,
    );
  });

  it('writes no documents: the masters are a company on its first morning', () => {
    const source = mastersSource();
    for (const forbidden of [
      'createPurchaseOrder',
      'postGoodsReceipt',
      'createProductionOrder',
      'createSalesOrder',
      'createDelivery',
      'createBillingDocument',
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('never writes around the product: every master goes through its own service', () => {
    const source = mastersSource();
    // A direct insert into a master table would bypass the judgements the service
    // makes — that the plant is active, that the price control is one the product
    // knows, that the unit converts.
    expect(source).not.toMatch(/\.insert\(/);
    expect(source).not.toMatch(/\.update\(/);
    for (const service of [
      'saveMaterialView',
      'saveBusinessPartner',
      'saveSupplierCompany',
      'saveSupplierPurchasing',
      'saveCustomerCompany',
      'saveCustomerSalesArea',
      'saveTaxCode',
      'createPurchasingInfoRecord',
      'saveSalesCondition',
      'createMaterialBom',
      'createRouting',
      'createProductionVersion',
    ]) {
      expect(source).toContain(service);
    }
  });

  it('forgives only a duplicate, so a master it could not write stops the run', () => {
    const source = mastersSource();
    expect(source).toContain('function ignoreExisting');
    // The last statement of the forgiver rethrows: anything that is not already
    // standing is a real failure and must not be swallowed.
    expect(source).toMatch(/ignoreExisting[\s\S]{0,900}?throw error;/);
  });
});

describe('demo masters, when the demo stands', () => {
  it('creates the materials the company makes, buys and sells', async () => {
    if (!(await demoStands())) return;
    expect(await count(`select count(*)::int as n from material where client = '${CLIENT}'`)).toBe(12);
    // Every material is extended to every plant it is kept at, and to a valuation
    // area there: a material with a basic view alone can be named but not moved.
    const plantViews = await count(`select count(*)::int as n from material_plant where client = '${CLIENT}'`);
    const valuations = await count(`select count(*)::int as n from material_valuation where client = '${CLIENT}'`);
    expect(plantViews).toBe(16);
    expect(valuations).toBe(plantViews);
    // Only the four sellable materials carry a sales view.
    expect(await count(`select count(*)::int as n from material_sales where client = '${CLIENT}'`)).toBe(4);
  });

  it('gives every material a complete view at every plant it stands at', async () => {
    if (!(await demoStands())) return;
    const incomplete = await rows(`
      select material_number, plant, mrp_status, purchasing_status
        from material_plant
       where client = '${CLIENT}'
         and (mrp_status in ('NOT_CREATED', 'INCOMPLETE')
              or (procurement_type in ('BUY', 'BOTH') and purchasing_status in ('NOT_CREATED', 'INCOMPLETE')))
    `);
    expect(incomplete).toEqual([]);
    const unvalued = await rows(`
      select material_number, valuation_area
        from material_valuation
       where client = '${CLIENT}' and accounting_status in ('NOT_CREATED', 'INCOMPLETE')
    `);
    expect(unvalued).toEqual([]);
  });

  it('holds raw materials only where they are turned into something', async () => {
    if (!(await demoStands())) return;
    // Nothing raw is kept at the distribution centre: the second plant exists so
    // finished stock can sit somewhere other than where it is made.
    const raw = await rows(`
      select mp.material_number, mp.plant
        from material_plant mp
        join material m on m.client = mp.client and m.material_number = mp.material_number
       where mp.client = '${CLIENT}'
         and m.material_type = 'RAW'
         and mp.plant = '${DEMO_STRUCTURE.distributionPlant}'
    `);
    expect(raw).toEqual([]);
    // Finished goods are kept at both.
    const finished = await rows(`
      select mp.plant, count(*)::int as n
        from material_plant mp
        join material m on m.client = mp.client and m.material_number = mp.material_number
       where mp.client = '${CLIENT}' and m.material_type = 'FIN'
       group by mp.plant order by mp.plant
    `);
    expect(finished).toEqual([
      { plant: DEMO_STRUCTURE.manufacturingPlant, n: 3 },
      { plant: DEMO_STRUCTURE.distributionPlant, n: 3 },
    ]);
  });

  it('creates the partners with the views that let a document use them', async () => {
    if (!(await demoStands())) return;
    expect(await count(`select count(*)::int as n from business_partner where client = '${CLIENT}'`)).toBe(7);
    // A supplier with only its general data is a name: the company view is what
    // lets a payable be posted, the purchasing view what lets an order be placed.
    expect(await count(`select count(*)::int as n from supplier_company_code where client = '${CLIENT}'`)).toBe(4);
    expect(await count(`select count(*)::int as n from supplier_purchasing_org where client = '${CLIENT}'`)).toBe(4);
    expect(await count(`select count(*)::int as n from customer_company_code where client = '${CLIENT}'`)).toBe(3);
    expect(await count(`select count(*)::int as n from customer_sales_area where client = '${CLIENT}'`)).toBe(3);
  });

  it('prices what it buys and what it sells', async () => {
    if (!(await demoStands())) return;
    // One info record per sourced material, and one selling price per customer
    // and material: three customers times four sellable materials.
    expect(await count(`select count(*)::int as n from purchasing_info_record where client = '${CLIENT}'`)).toBe(8);
    expect(await count(`select count(*)::int as n from sales_condition_record where client = '${CLIENT}'`)).toBe(12);
    // The demo sells above cost, because a company selling at cost has no margin
    // to say anything about.
    const margins = await rows(`
      select count(*)::int as n
        from sales_condition_record s
        join material_valuation v
          on v.client = s.client and v.material_number = s.material_number
         and v.valuation_area = '${DEMO_STRUCTURE.manufacturingPlant}'
       where s.client = '${CLIENT}'
         and s.amount <= greatest(v.standard_price, v.moving_average_price)
    `);
    expect(margins[0]?.n).toBe(0);
  });

  it('creates the bills of material, routings and production versions it needs', async () => {
    if (!(await demoStands())) return;
    expect(await count(`select count(*)::int as n from material_bom where client = '${CLIENT}'`)).toBe(4);
    expect(await count(`select count(*)::int as n from material_bom_item where client = '${CLIENT}'`)).toBe(14);
    expect(await count(`select count(*)::int as n from routing where client = '${CLIENT}'`)).toBe(4);
    // Two operations per routing — mix, then pack.
    expect(await count(`select count(*)::int as n from routing_operation where client = '${CLIENT}'`)).toBe(8);
    expect(await count(`select count(*)::int as n from production_version where client = '${CLIENT}'`)).toBe(4);
  });

  it('defines the production configuration the product leaves empty', async () => {
    if (!(await demoStands())) return;
    // A new tenant has none of these, and without them no BOM and no routing can
    // be written at all.
    expect(await count(`select count(*)::int as n from bom_usage where client = '${CLIENT}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from bom_status where client = '${CLIENT}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from bom_item_category where client = '${CLIENT}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from routing_task_list_type where client = '${CLIENT}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from routing_usage where client = '${CLIENT}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from routing_control_key where client = '${CLIENT}'`)).toBe(1);
    expect(await count(`select count(*)::int as n from routing_status where client = '${CLIENT}'`)).toBe(1);
  });

  it('defines tax codes, which no seed creates and every purchase needs', async () => {
    if (!(await demoStands())) return;
    expect(await count(`select count(*)::int as n from tax_code where client = '${CLIENT}'`)).toBe(3);
  });

  it('records the provisioner as the actor on every master it wrote', async () => {
    if (!(await demoStands())) return;
    const others = await rows(`
      select 'material' as object, count(*)::int as n from material where client = '${CLIENT}' and created_by <> 'DEMO_PROVISION'
      union all
      select 'business_partner', count(*)::int from business_partner where client = '${CLIENT}' and created_by <> 'DEMO_PROVISION'
      union all
      select 'production_version', count(*)::int from production_version where client = '${CLIENT}' and created_by <> 'DEMO_PROVISION'
    `);
    for (const row of others) expect(row.n).toBe(0);
  });
});
