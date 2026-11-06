import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder, resolveItemTolerances } from '../src/modules/purchasing/orders';
import { getReceiptOrder } from '../src/modules/inventory/goods-receipt';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { deliveryCompletionDecision } from '../src/modules/purchasing/delivery-completion';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

const ACTOR = 'PODC_DELIVERY_CONTROL_TEST';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };
const MATERIAL = 'MAT-20001';
const PLANT = '1000';
const COMPANY = '1000';

/**
 * Delivery control on a purchase order item: the tolerance the order carries is the one a
 * receipt is judged against, not the one a master carries today; an item can be closed; an
 * item can refuse to receive goods at all; and whether a receipt closes an item is a rule
 * the company keeps with a plant override, not a constant.
 */
describe('purchase order delivery control', () => {
  let client = '';

  afterAll(async () => {
    if (client) await destroyTenant(client);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('po-delivery-control');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, {
          client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR,
        });
        await defineRange(tx, {
          client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR,
        });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V20000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V20000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
          values (${client}, 'V20000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${client}, ${MATERIAL}, 'Delivery control plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, overdelivery_tolerance, underdelivery_tolerance, created_by)
          values (${client}, ${MATERIAL}, ${PLANT}, 10, 5, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, valuation_class, price_control,
            standard_price, moving_average_price, price_unit, currency, created_by
          )
          values (${client}, ${MATERIAL}, ${PLANT}, 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
          on conflict do nothing
        `);
      });
      await initializeMaterialPeriodControl({
        client, changedBy: ACTOR, companyCode: COMPANY, fiscalYear: 2026, period: 10,
        reason: 'Delivery control test',
      });
    }
    return client;
  }

  const header = {
    supplierNumber: 'V20000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: COMPANY, currency: '',
  };

  /** Small values on purpose: no release strategy claims an order this size. */
  const item = (quantity: number, over: Partial<{
    overdeliveryTolerance: string; underdeliveryTolerance: string;
    unlimitedOverdelivery: boolean; deliveryCompleted: boolean; goodsReceiptIndicator: boolean;
    materialNumber: string;
  }> = {}) => ({
    materialNumber: MATERIAL, shortText: 'Delivery control plate', quantity, unit: 'PC',
    netPrice: 5, priceUnit: 1, taxCode: '', plant: PLANT, storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
    ...over,
  });

  async function post(orderNumber: string, requestKey: string, quantity: number): Promise<void> {
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber, ...POSTING, requestKey,
      lines: [{ itemNumber: 10, quantity }],
    });
  }

  describe('the resolution, which needs no database', () => {
    it('takes the buyer first, then the material, then the info record, then zero', () => {
      const from = (over: string) => resolveItemTolerances({
        overdelivery: over, underdelivery: '',
        materialPlant: { overdeliveryTolerance: '10', underdeliveryTolerance: '5' },
        infoRecord: { overdeliveryTolerance: '20', underdeliveryTolerance: '1' },
      }).overdeliveryTolerance;
      expect(from('2')).toBe('2.00');
      expect(from('')).toBe('10.00');
      expect(resolveItemTolerances({
        overdelivery: '', underdelivery: '',
        materialPlant: null,
        infoRecord: { overdeliveryTolerance: '20', underdeliveryTolerance: '1' },
      }).overdeliveryTolerance).toBe('20.00');
      expect(resolveItemTolerances({
        overdelivery: '', underdelivery: '', materialPlant: null, infoRecord: null,
      }).underdeliveryTolerance).toBe('0.00');
    });

    it('refuses a tolerance that is not a percentage', () => {
      expect(() => resolveItemTolerances({
        overdelivery: '101', underdelivery: '',
        materialPlant: null, infoRecord: null,
      })).toThrow('does not stand between 0 and 100');
      expect(() => resolveItemTolerances({
        overdelivery: '', underdelivery: '-4',
        materialPlant: null, infoRecord: null,
      })).toThrow('does not stand between 0 and 100');
    });
  });

  describe('the closing decision, which needs no database', () => {
    it('never closes anything where the rule is off', () => {
      const decision = deliveryCompletionDecision({
        autoClose: false, ordered: 100, receivedAfter: 100, underdeliveryTolerance: 5,
      });
      expect(decision.close).toBe(false);
      expect(decision.reason).toContain('not set by a receipt');
    });

    it('closes once the receipt reaches the underdelivery floor, and not before', () => {
      const at = deliveryCompletionDecision({
        autoClose: true, ordered: 100, receivedAfter: 95, underdeliveryTolerance: 5,
      });
      expect(at.close).toBe(true);
      const below = deliveryCompletionDecision({
        autoClose: true, ordered: 100, receivedAfter: 94.999, underdeliveryTolerance: 5,
      });
      expect(below.close).toBe(false);
      expect(below.reason).toContain('below the underdelivery floor');
      // Overshooting closes it as well: the quantity was met and passed.
      expect(deliveryCompletionDecision({
        autoClose: true, ordered: 100, receivedAfter: 130, underdeliveryTolerance: 5,
      }).close).toBe(true);
    });
  });

  describe('the order is judged against its own figures', () => {
    it('keeps the tolerance it snapshotted, even when the material is later changed', async () => {
      const c = await standingClient();
      // The material carries 10%, so the item snapshots 10%.
      const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(100)] });
      await withTenant(c, (tx) => tx.execute(sql`
        update material_plant set overdelivery_tolerance = 0
        where client = ${c} and material_number = ${MATERIAL} and plant = ${PLANT}
      `));
      // The order still carries 10%, so 108 of 100 stands.
      await post(order.orderNumber, 'req-snapshot-kept', 108);
      await withTenant(c, (tx) => tx.execute(sql`
        update material_plant set overdelivery_tolerance = 10
        where client = ${c} and material_number = ${MATERIAL} and plant = ${PLANT}
      `));
    });

    it('is judged against the tolerance the order states, not the one the master carries', async () => {
      const c = await standingClient();
      const order = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { overdeliveryTolerance: '0' })],
      });
      await expect(post(order.orderNumber, 'req-order-tolerance', 105)).rejects
        .toThrow('beyond the overdelivery tolerance of 0% that this order carries');
    });

    it('has no ceiling at all where overdelivery is unlimited', async () => {
      const c = await standingClient();
      const order = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { unlimitedOverdelivery: true })],
      });
      await post(order.orderNumber, 'req-unlimited', 400);
    });
  });

  describe('an item that cannot receive', () => {
    it('refuses a receipt once the item is closed for delivery', async () => {
      const c = await standingClient();
      const order = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { deliveryCompleted: true })],
      });
      await expect(post(order.orderNumber, 'req-closed', 10)).rejects
        .toThrow('closed for delivery');
    });

    it('refuses a receipt where the item does not receive goods', async () => {
      const c = await standingClient();
      const order = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { goodsReceiptIndicator: false })],
      });
      await expect(post(order.orderNumber, 'req-no-gr', 10)).rejects
        .toThrow('does not receive goods');
    });

    it('carries the indicator off for an item with no material', async () => {
      const c = await standingClient();
      const order = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [{ ...item(10), materialNumber: '', shortText: 'A text line' }],
      });
      const view = await getReceiptOrder(c, order.orderNumber);
      expect(view?.items[0].goodsReceiptIndicator).toBe(false);
    });
  });

  describe('whether a receipt closes the item is a rule, not a constant', () => {
    it('leaves the item open where no rule stands, closes it under a company rule, and lets a plant row overrule the company', async () => {
      const c = await standingClient();
      const under = 5;
      // 96 of 100 is inside the 5% underdelivery floor, so it is a candidate for closing.
      const open = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { underdeliveryTolerance: String(under) })],
      });
      await post(open.orderNumber, 'req-close-none', 96);
      expect((await getReceiptOrder(c, open.orderNumber))?.items[0].deliveryCompleted).toBe(false);

      await withTenant(c, (tx) => tx.execute(sql`
        insert into purchase_delivery_completion_policy (client, company_code, auto_close, created_by, changed_by)
        values (${c}, ${COMPANY}, true, ${ACTOR}, ${ACTOR})
        on conflict (client, company_code) do update set auto_close = excluded.auto_close
      `));
      const byCompany = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { underdeliveryTolerance: String(under) })],
      });
      await post(byCompany.orderNumber, 'req-close-company', 96);
      expect((await getReceiptOrder(c, byCompany.orderNumber))?.items[0].deliveryCompleted).toBe(true);

      await withTenant(c, (tx) => tx.execute(sql`
        insert into purchase_delivery_completion_plant (client, plant, auto_close, created_by, changed_by)
        values (${c}, ${PLANT}, false, ${ACTOR}, ${ACTOR})
        on conflict (client, plant) do update set auto_close = excluded.auto_close
      `));
      const byPlant = await createOrder({
        client: c, changedBy: ACTOR, ...header,
        items: [item(100, { underdeliveryTolerance: String(under) })],
      });
      await post(byPlant.orderNumber, 'req-close-plant', 96);
      expect((await getReceiptOrder(c, byPlant.orderNumber))?.items[0].deliveryCompleted).toBe(false);
    });
  });
});
