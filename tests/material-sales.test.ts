/**
 * DI-018 (§2.2) — the material sales view.
 *
 * A material was known to sales only by its plant extension, which says whether a warehouse can carry
 * it and nothing about whether it may be sold. The sales view is where that is now said: the unit the
 * material is sold in, the kind of order item it becomes, the plant it ships from, the account
 * assignment group its revenue is determined by, and the groups the shipping point and the availability
 * check will read.
 *
 * The last thing this file proves is the one that makes the view a view rather than a set of fields: a
 * material with no sales view in a sales area cannot be sold there, and the refusal names the screen
 * where it is maintained.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { saveCustomerCredit } from '../src/modules/finance/credit';
import { changeHistory } from '../src/platform/change';
import { saveSalesCondition } from '../src/modules/sales/conditions';
import { SalesOrderError, createSalesOrder } from '../src/modules/sales/sales-order';
import { MaterialSalesError, assertMaterialSalesArea } from '../src/modules/sales/material-sales';
import { saveMaterialView } from '../src/modules/inventory/materials';
import {
  assignSalesAreaDimensions, createTenant, defineTestRanges, destroyTenant, maintainMaterialSales,
  type TestTenant,
} from './helpers';

const ACTOR = 'SD9240_SALES_VIEW';
const AREA = 'CCA1';
const CUSTOMER = 'SD9240CUST1';
const MATERIAL = 'SD9240MAT1';
const PLANT = '1000';
const DATE = '2026-10-15';

const base = {
  client: '',
  changedBy: ACTOR,
  salesOrg: '1000',
  distributionChannel: '10',
  division: '01',
  customerNumber: CUSTOMER,
  companyCode: '1000',
  currency: 'USD',
  orderDate: DATE,
};

describe('the material sales view', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTenant('sd9240-material-sales');
    base.client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(tenant.client, async (tx) => {
      await defineRange(tx, {
        client: tenant.client, objectCode: 'SALESORD', subObject: 'OR', prefix: 'SO', numberLength: 7, createdBy: ACTOR,
      });
      await assignSalesAreaDimensions(tenant, '1000', [
        { distributionChannel: '10', division: '01' }, { distributionChannel: '20', division: '01' },
      ]);
      await tx.execute(sql`
        insert into unit_of_measure (code, name, dimension, decimal_places, is_base_unit)
        values ('UNT', 'Test counted unit', 'COUNT', 0, false)
        on conflict (code) do update set decimal_places = excluded.decimal_places
      `);
      await tx.execute(sql`
        insert into sales_org (client, sales_org, company_code, currency, created_by)
        values (${tenant.client}, '1000', '1000', 'USD', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_org_text (client, sales_org, language_key, name, created_by)
        values (${tenant.client}, '1000', 'E', 'Sales view test organization', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into sales_area (client, sales_org, distribution_channel, division, name, created_by)
        values (${tenant.client}, '1000', '10', '01', 'Sales view test area', ${ACTOR}),
               (${tenant.client}, '1000', '20', '01', 'Sales view export area', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into plant (client, plant, name, company_code, country, created_by)
        values (${tenant.client}, ${PLANT}, 'Sales view test plant', '1000', 'KW', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_control_area (client, credit_control_area, name, currency, warning_threshold_percent, created_by)
        values (${tenant.client}, ${AREA}, 'Sales view credit area', 'USD', 90, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into credit_risk_category (client, risk_category, name, created_by)
        values (${tenant.client}, 'A', 'Low risk', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        update company_code set credit_control_area = ${AREA}
        where client = ${tenant.client} and company_code = '1000'
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${tenant.client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'ORGANIZATION', 'Sales view test customer', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into customer_sales_area (
          client, partner_number, role_code, sales_org, distribution_channel, division,
          pricing_procedure, is_blocked, sales_status, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', '10', '01', 'PR01', false, 'MAINTAINED', ${ACTOR})
        on conflict (client, partner_number, sales_org, distribution_channel, division)
        do update set is_blocked = false, sales_status = 'MAINTAINED'
      `);
      await tx.execute(sql`
        insert into customer_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        )
        values (${tenant.client}, ${CUSTOMER}, 'CUSTOMER', '1000', 'CA01', '110000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${MATERIAL}, 'Sales view test material', 'RAW', 'UNT', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${MATERIAL}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
        values (${tenant.client}, 'KW', 'T10', 'Output tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
      `);
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: MATERIAL, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });
    await saveCustomerCredit({
      client: tenant.client, changedBy: ACTOR, customer: CUSTOMER, creditControlArea: AREA,
      creditLimit: '1000000.00', riskCategory: 'A', isBlocked: false, changeReason: 'Sales view test credit data.',
    });
  });

  afterAll(async () => {
    if (tenant) await destroyTenant(tenant.client);
  });

  it('maintains the view a sales area reads, and reports a second save of the same values as no change', async () => {
    const saved = await saveMaterialView({
      client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, expectedVersion: 0,
      reason: 'Material is sold in the home market.', view: 'SALES',
      salesOrg: '1000', distributionChannel: '10',
      salesUnit: '', itemCategoryGroup: 'NORM', materialAccountAssignmentGroup: 'FIN',
      deliveringPlant: PLANT, loadingGroup: '0001', availabilityCheckGroup: '02',
    });
    expect(saved.changed).toBe(true);
    expect(saved.status).toBe('CREATED');

    const again = await saveMaterialView({
      client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, expectedVersion: saved.version,
      reason: 'No change at all.', view: 'SALES',
      salesOrg: '1000', distributionChannel: '10',
      salesUnit: '', itemCategoryGroup: 'NORM', materialAccountAssignmentGroup: 'FIN',
      deliveringPlant: PLANT, loadingGroup: '0001', availabilityCheckGroup: '02',
    });
    expect(again.changed).toBe(false);
    expect(again.status).toBe('CREATED');
  });

  it('reads the view back as a sales document reads it', async () => {
    const view = await withTenant(tenant.client, (tx) => assertMaterialSalesArea(tx, tenant.client, {
      materialNumber: MATERIAL, salesOrg: '1000', distributionChannel: '10',
    }));
    expect(view).toMatchObject({
      materialNumber: MATERIAL, salesOrg: '1000', distributionChannel: '10',
      // A blank sales unit is the base unit, not an absence.
      salesUnit: null, itemCategoryGroup: 'NORM', materialAccountAssignmentGroup: 'FIN',
      deliveringPlant: PLANT, loadingGroup: '0001', availabilityCheckGroup: '02',
    });
    // A change to the view is a change to the master, and it is written down as one.
    const history = await withTenant(tenant.client, (tx) =>
      changeHistory(tx, tenant.client, 'material_sales', `${MATERIAL}/1000/10`));
    expect(history.length).toBeGreaterThan(0);
  });

  it('holds a second sales area apart, and refuses a channel that does not stand', async () => {
    await saveMaterialView({
      client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, expectedVersion: 0,
      reason: 'Also sold through the export channel.', view: 'SALES',
      salesOrg: '1000', distributionChannel: '20',
      salesUnit: '', itemCategoryGroup: 'NORM', materialAccountAssignmentGroup: 'TRAD',
      deliveringPlant: PLANT, loadingGroup: '0002', availabilityCheckGroup: '',
    });
    const home = await withTenant(tenant.client, (tx) => assertMaterialSalesArea(tx, tenant.client, {
      materialNumber: MATERIAL, salesOrg: '1000', distributionChannel: '10',
    }));
    const away = await withTenant(tenant.client, (tx) => assertMaterialSalesArea(tx, tenant.client, {
      materialNumber: MATERIAL, salesOrg: '1000', distributionChannel: '20',
    }));
    expect(home.materialAccountAssignmentGroup).toBe('FIN');
    expect(away.materialAccountAssignmentGroup).toBe('TRAD');

    await expect(saveMaterialView({
      client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, expectedVersion: 0,
      reason: 'A channel nobody maintains.', view: 'SALES',
      salesOrg: '1000', distributionChannel: '99',
      salesUnit: '', itemCategoryGroup: 'NORM', materialAccountAssignmentGroup: '',
      deliveringPlant: '', loadingGroup: '', availabilityCheckGroup: '',
    })).rejects.toThrow(/Distribution channel 99 does not exist/);
  });

  it('refuses an order for a material that is not maintained for sale in the sales area, and names the screen', async () => {
    const unmaintained = 'SD9240MAT2';
    await withTenant(tenant.client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${tenant.client}, ${unmaintained}, 'Never maintained for sale', 'RAW', 'UNT', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${tenant.client}, ${unmaintained}, ${PLANT}, ${ACTOR}) on conflict do nothing
      `);
    });
    await saveSalesCondition({
      client: tenant.client, changedBy: ACTOR, salesOrg: '1000', distributionChannel: '10', division: '01',
      customerNumber: '', materialNumber: unmaintained, currency: 'USD', amount: 25, priceUnit: 1,
      validityFrom: '2026-01-01', validityTo: '2026-12-31', supersedeStanding: false,
    });

    let refusal: { message: string; remedy?: string } | undefined;
    try {
      await createSalesOrder({
        ...base, requestKey: 'SD9240-UNMAINTAINED',
        lines: [{
          lineNumber: undefined, materialNumber: unmaintained, plant: PLANT,
          orderQuantity: 1, quantityUnit: 'UNT',
        }],
      });
    } catch (error) {
      refusal = error as { message: string; remedy?: string };
    }
    // The plant carries it and a price stands for it. What does not stand is the material for sale here.
    expect(refusal).toBeInstanceOf(SalesOrderError);
    expect(refusal?.message).toMatch(/has no sales view for sales area 1000\/10/);
    expect(refusal?.remedy).toContain('/inventory/materials');

    // Maintained for sale, the same order is accepted: the refusal was the view and nothing else.
    await maintainMaterialSales(tenant, { materialNumber: unmaintained, deliveringPlant: PLANT });
    const placed = await createSalesOrder({
      ...base, requestKey: 'SD9240-MAINTAINED',
      lines: [{
        lineNumber: undefined, materialNumber: unmaintained, plant: PLANT,
        orderQuantity: 1, quantityUnit: 'UNT',
      }],
    });
    expect(placed.orderNumber).toMatch(/^SO-/);
  });

  it('refuses a view that is saved incomplete, and refuses a stale version', async () => {
    let refusal: MaterialSalesError | undefined;
    try {
      await withTenant(tenant.client, (tx) => assertMaterialSalesArea(tx, tenant.client, {
        materialNumber: 'SD9240NONE', salesOrg: '1000', distributionChannel: '10',
      }));
    } catch (error) {
      refusal = error as MaterialSalesError;
    }
    expect(refusal?.message).toMatch(/has no sales view/);

    // A second maintainer holding the version the view had before it was ever saved. The view stands at
    // version 1 now, so a save against 0 is a save over a change this maintainer has not seen.
    await expect(saveMaterialView({
      client: tenant.client, changedBy: ACTOR, materialNumber: MATERIAL, expectedVersion: 0,
      reason: 'Saving over a change made since.', view: 'SALES',
      salesOrg: '1000', distributionChannel: '10',
      salesUnit: '', itemCategoryGroup: 'PACK', materialAccountAssignmentGroup: 'FIN',
      deliveringPlant: PLANT, loadingGroup: '0001', availabilityCheckGroup: '02',
    })).rejects.toThrow(/changed after it was opened/);
  });
});
