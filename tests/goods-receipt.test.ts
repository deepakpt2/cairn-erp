import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';

const requestContext = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => requestContext.cookie ? { value: requestContext.cookie } : undefined }),
}));
vi.mock('next/navigation', () => ({
  redirect: (path: string): never => { throw new Error(`REDIRECT:${path}`); },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder, getOrder } from '../src/modules/purchasing/orders';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import {
  getMaterialDocument, getReceiptOrder, postGoodsReceipt as postGoodsReceiptRaw,
  reverseGoodsReceipt as reverseGoodsReceiptRaw,
} from '../src/modules/inventory/goods-receipt';
import { postGoodsReceipt, reverseGoodsReceipt } from './helpers/goods-receipt-authorized';
import { defineUomConversion, removeUomConversion } from '../src/modules/inventory/unit-conversion';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';
import {
  appUser, authOrgRestriction, capability, role, roleCapability, userRole,
} from '../src/platform/tables/security';
import { createSession, encodeSessionCookie } from '../src/platform/auth/session';
import { hashPassword } from '../src/platform/auth/password';
import { postGoodsReceiptAction, reverseGoodsReceiptAction } from '../src/app/inventory/goods-receipt/actions';

const ACTOR = 'SCR061_MIGO_TEST';
const POSTING = { documentDate: '2026-10-18', postingDate: '2026-10-18' };

/**
 * SCR-061 acceptance: the goods receipt posts document, stock,
 * valuation and balanced journal in one transaction; open quantity
 * comes from posted history and judges the tolerance; a released
 * order is required where a strategy claimed it; a flagged material
 * refuses; reversal is a new document and nothing is edited.
 */
describe('SCR-061 goods receipt (MIGO)', () => {
  let client = '';
  let foreignClient = '';
  type TestActor = { userId: string; sessionId: string; token: string };
  let authorisedActor: TestActor = { userId: '', sessionId: '', token: '' };
  let noPlantActor: TestActor = { userId: '', sessionId: '', token: '' };
  let noCompanyActor: TestActor = { userId: '', sessionId: '', token: '' };
  let noCapabilityActor: TestActor = { userId: '', sessionId: '', token: '' };

  afterAll(async () => {
    requestContext.cookie = undefined;
    if (client) await destroyTenant(client);
    if (foreignClient) await destroyTenant(foreignClient);
  });

  async function standingClient(): Promise<string> {
    if (!client) {
      const tenant = await createTenant('scr061-goods-receipt');
      client = tenant.client;
      await defineTestRanges(tenant, { fiscalYear: 2026 });
      await withTenant(client, async (tx) => {
        await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
        await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
        await tx.execute(sql`
          insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
          values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into business_partner (client, partner_number, category, name, created_by)
          values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into bp_role (client, partner_number, role_code, created_by)
          values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
          values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material (client, material_number, description, material_type, base_unit, created_by)
          values (${client}, 'MAT-10001', 'Industrial steel plate', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
          values (${client}, 'MAT-10001', '1000', 0, ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into material_valuation (
            client, material_number, valuation_area, valuation_class, price_control,
            standard_price, moving_average_price, price_unit, currency, created_by
          )
          values (${client}, 'MAT-10001', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
          values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
                 (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR})
          on conflict do nothing
        `);
        // A release strategy claiming orders of 1000 and above, unreleased at first.
        await tx.execute(sql`
          insert into characteristic (client, characteristic_name, description, data_format, value_length, decimal_places, lifecycle_status, created_by)
          values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into class_type (client, class_type, description, object_category, created_by)
          values (${client}, 'PURCHASE_ORDER', 'Purchase order release classes', 'PURCHASING', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
          values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 'Purchase order release', 'ACTIVE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
          values (${client}, 'PURCHASE_ORDER', 'PO_RELEASE', 1, 'TOTAL_VALUE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_group (client, group_code, document_category, description, created_by)
          values (${client}, 'PO', 'PURCHASE_ORDER', 'Purchase order releases', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_code (client, group_code, code, description, created_by)
          values (${client}, 'PO', 'MGR', 'Purchasing manager', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_strategy (client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by)
          values (${client}, 'PO', 'HIGH', 'High value orders', 'PURCHASE_ORDER', 'PO_RELEASE', 100, 'ACTIVE', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_strategy_criterion (client, group_code, strategy_code, characteristic_name, operator, value_from, created_by)
          values (${client}, 'PO', 'HIGH', 'TOTAL_VALUE', 'GE', '1000', ${ACTOR}) on conflict do nothing
        `);
        await tx.execute(sql`
          insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
          values (${client}, 'PO', 'HIGH', 1, 'MGR', ${ACTOR}) on conflict do nothing
        `);
      });
      await initializeMaterialPeriodControl({
        client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Goods receipt organisation authorisation',
      });
      await withTenant(client, async (tx) => {
        await tx.execute(sql`
          insert into company_code (
            client, company_code, name, chart_of_accounts, fiscal_year_variant,
            posting_period_variant, currency, country, created_by
          )
          select client, 'GR2000', 'Other goods receipt company', chart_of_accounts,
                 fiscal_year_variant, posting_period_variant, currency, country, ${ACTOR}
            from company_code where client = ${client} and company_code = '1000'
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into plant (client, plant, name, company_code, country, created_by) values
            (${client}, 'GR-SAME', 'Same-company unassigned plant', '1000', 'KW', ${ACTOR}),
            (${client}, 'GR-OTHER', 'Other-company plant', 'GR2000', 'KW', ${ACTOR}),
            (${client}, 'GR-NOCO', 'Plant without company assignment', null, 'KW', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into purchase_order (
            client, order_number, supplier_number, purchasing_org, purchasing_group,
            company_code, currency, document_date, created_by
          ) values
            (${client}, 'GR-SAME-PO', 'V10000', '1000', '001', '1000', 'USD', '2026-10-18', ${ACTOR}),
            (${client}, 'GR-OTHER-PO', 'V10000', '1000', '001', 'GR2000', 'USD', '2026-10-18', ${ACTOR}),
            (${client}, 'GR-NOCO-PO', 'V10000', '1000', '001', '1000', 'USD', '2026-10-18', ${ACTOR}),
            (${client}, 'GR-MISMATCH-PO', 'V10000', '1000', '001', '1000', 'USD', '2026-10-18', ${ACTOR})
          on conflict do nothing
        `);
        await tx.execute(sql`
          insert into purchase_order_item (
            client, order_number, item_number, material_number, short_text, quantity, unit,
            net_price, price_unit, net_value, plant, created_by
          ) values
            (${client}, 'GR-SAME-PO', 10, 'MAT-10001', 'Unauthorised same-company item', 1, 'PC', 100, 1, 100, 'GR-SAME', ${ACTOR}),
            (${client}, 'GR-OTHER-PO', 10, 'MAT-10001', 'Unauthorised other-company item', 1, 'PC', 100, 1, 100, 'GR-OTHER', ${ACTOR}),
            (${client}, 'GR-NOCO-PO', 10, 'MAT-10001', 'Plant ownership missing', 1, 'PC', 100, 1, 100, 'GR-NOCO', ${ACTOR}),
            (${client}, 'GR-MISMATCH-PO', 10, 'MAT-10001', 'Order and plant company mismatch', 1, 'PC', 100, 1, 100, 'GR-OTHER', ${ACTOR})
          on conflict do nothing
        `);
        await tx.insert(capability).values({
          code: 'INV.GR.POST', module: 'INV', description: 'Post goods receipt', action: 'POST',
        }).onConflictDoNothing();
        await tx.insert(role).values({
          client, code: 'TEST_GR_ORG', name: 'Goods receipt organisation test',
          description: 'Temporary goods receipt test authority', isSystemRole: false, isReadOnly: false,
          createdBy: ACTOR,
        }).onConflictDoNothing();
        await tx.insert(roleCapability).values({
          client, roleCode: 'TEST_GR_ORG', capabilityCode: 'INV.GR.POST', createdBy: ACTOR,
        }).onConflictDoNothing();
        await tx.insert(role).values({
          client, code: 'TEST_GR_NO_CAP', name: 'Goods receipt no-capability test',
          description: 'Temporary user role with no goods receipt capability', isSystemRole: false, isReadOnly: false,
          createdBy: ACTOR,
        }).onConflictDoNothing();
        const createActor = async (
          username: string, companies: string[], plants: string[], roleCode = 'TEST_GR_ORG',
        ) => {
          const userId = randomUUID();
          await tx.insert(appUser).values({
            id: userId, client, username, fullName: username,
            passwordHash: await hashPassword('GoodsReceiptAuthTest123!'), isActive: true, createdBy: ACTOR,
          });
          await tx.insert(userRole).values({ client, userId, roleCode, createdBy: ACTOR });
          const restrictions = [
            ...companies.map((scopeValue) => ({ id: randomUUID(), client, userId, scopeType: 'COMPANY_CODE', scopeValue, createdBy: ACTOR })),
            ...plants.map((scopeValue) => ({ id: randomUUID(), client, userId, scopeType: 'PLANT', scopeValue, createdBy: ACTOR })),
          ];
          if (restrictions.length) await tx.insert(authOrgRestriction).values(restrictions);
          const session = await createSession(tx, { client, userId });
          const sessions = await tx.execute(sql`
            select id from user_session where client = ${client} and user_id = ${userId}
            order by issued_at desc limit 1
          `) as unknown as Array<{ id: string }>;
          return { userId, sessionId: sessions[0].id, token: session.token };
        };
        authorisedActor = await createActor('scr061.goods-receipt.authorised', ['1000'], ['1000']);
        noPlantActor = await createActor('scr061.goods-receipt.no-plant', ['1000'], []);
        noCompanyActor = await createActor('scr061.goods-receipt.no-company', [], ['1000']);
        noCapabilityActor = await createActor('scr061.goods-receipt.no-capability', ['1000'], ['1000'], 'TEST_GR_NO_CAP');
      });
    }
    return client;
  }

  const header = {
    supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
  };
  const item = (quantity: number, netPrice: number) => ({
    materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity, unit: 'PC',
    netPrice, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
  });

  async function stockAndValuation(c: string) {
    return withTenant(c, async (tx) => {
      const stock = await tx.execute(sql`
        select quantity from stock_quantity
        where client = ${c} and material_number = 'MAT-10001' and plant = '1000'
      `);
      const valuation = await tx.execute(sql`
        select total_stock_quantity, stock_value, moving_average_price from material_valuation
        where client = ${c} and material_number = 'MAT-10001' and valuation_area = '1000'
      `);
      return {
        stock: stock as unknown as Array<{ quantity: string }>,
        valuation: (valuation as unknown as Array<Record<string, string>>)[0],
      };
    });
  }

  async function postingSnapshot(targetClient = client) {
    return withTenant(targetClient, async (tx) => {
      const rows = await tx.execute(sql`
        select
          (select count(*)::text from material_document where client = ${targetClient}) as documents,
          (select count(*)::text from material_document_line where client = ${targetClient}) as lines,
          (select count(*)::text from journal_entry where client = ${targetClient}) as journals,
          (select count(*)::text from journal_entry_line where client = ${targetClient}) as journal_lines,
          (select count(*)::text from change_document where client = ${targetClient}) as changes,
          (select count(*)::text from document_flow_link where client = ${targetClient}) as document_links,
          (select count(*)::text from document_status_history where client = ${targetClient}) as status_history,
          (select count(*)::text from output_message where client = ${targetClient}) as outputs,
          (select count(*)::text from stock_quantity where client = ${targetClient}) as stock_rows,
          (select coalesce(sum(quantity), 0)::text from stock_quantity where client = ${targetClient}) as stock_quantity,
          (select count(*)::text from material_valuation where client = ${targetClient}) as valuation_rows,
          (select coalesce(sum(total_stock_quantity), 0)::text from material_valuation where client = ${targetClient}) as valuation_quantity,
          (select coalesce(sum(stock_value), 0)::text from material_valuation where client = ${targetClient}) as valuation_value
      `) as unknown as Array<Record<string, string>>;
      return rows[0];
    });
  }

  function setSession(actor: TestActor | undefined) {
    requestContext.cookie = actor ? encodeSessionCookie(client, actor.token) : undefined;
  }

  function receiptForm(orderNumber: string, requestKey: string, extras: Record<string, string> = {}) {
    const form = new FormData();
    const values = {
      orderNumber, requestKey, documentDate: '2026-10-18', postingDate: '2026-10-18',
      headerText: 'GR auth test', 'qty-10': '1', ...extras,
    };
    for (const [name, value] of Object.entries(values)) form.set(name, value);
    return form;
  }

  // ── the unit a receipt is spoken in, and the unit stock is kept in ──────────────
  // A purchase order may be placed in a packaging unit while the material is stocked in its
  // base unit; `purchasing/orders.ts` admits such an item only when the material carries the
  // conversion. So the receipt knows both numbers, and the two are not interchangeable: the
  // document keeps what was entered in the unit it was entered in, while stock, valuation and
  // the MRP ledger are the material's base unit — which `stock_quantity` has no column for and
  // therefore can only ever hold in that unit.
  it('posts the entered quantity as entered and the converted quantity as the base quantity, and moves stock, valuation and the order history by it', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${c}, 'MAT-BOX', 'Cased gaskets', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${c}, 'MAT-BOX', '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency, created_by)
        values (${c}, 'MAT-BOX', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
    });
    await defineUomConversion({
      client: c, changedBy: ACTOR, materialNumber: 'MAT-BOX', alternativeUnit: 'BOX', numerator: 12, denominator: 1,
    });
    const onHand = async () => withTenant(c, async (tx) => {
      const stock = await tx.execute(sql`
        select coalesce(sum(quantity), 0)::float8 as quantity from stock_quantity
         where client = ${c} and material_number = 'MAT-BOX' and plant = '1000'
      `) as unknown as Array<{ quantity: number }>;
      const valuation = await tx.execute(sql`
        select total_stock_quantity::float8 as total_stock_quantity, stock_value::float8 as stock_value,
               moving_average_price::float8 as moving_average_price
          from material_valuation where client = ${c} and material_number = 'MAT-BOX' and valuation_area = '1000'
      `) as unknown as Array<Record<string, number>>;
      return { stock: stock[0]?.quantity ?? 0, ...valuation[0]! };
    });
    expect(await onHand()).toEqual({ stock: 0, total_stock_quantity: 0, stock_value: 0, moving_average_price: 0 });

    const order = await createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [{ ...item(3, 40), materialNumber: 'MAT-BOX', shortText: 'Cased gaskets', unit: 'BOX' }],
    });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-box-post', lines: [{ itemNumber: 10, quantity: 3 }],
    });
    const line = (await withTenant(c, async (tx) => tx.execute(sql`
      select entry_quantity::float8 as entry_quantity, entry_unit, base_quantity::float8 as base_quantity, base_unit
        from material_document_line where client = ${c} and material_document_number = ${doc.materialDocumentNumber}
    `))) as unknown as Array<Record<string, string | number>>;
    // Both pairs stand, and they are not the same number: three cases were ordered and received,
    // thirty-six pieces entered the store.
    expect(line[0]).toMatchObject({ entry_quantity: 3, entry_unit: 'BOX', base_quantity: 36, base_unit: 'PC' });

    // Stock and the valuation quantity follow the base unit; the money is what the order speaks.
    expect(await onHand()).toMatchObject({
      stock: 36, total_stock_quantity: 36, stock_value: 120,
      // 120 USD for 36 pieces is 3.33 each. Read as 3 pieces it would have said 40, the price
      // of one box, and the next issue would have valued thirty-six pieces at that.
      moving_average_price: 3.33,
    });

    // The order's own history stays in the unit the order was placed in, because that is the unit
    // the buyer reads and the unit the receipt line is entered in.
    const afterReceipt = await getReceiptOrder(c, order.orderNumber);
    expect(afterReceipt?.items[0]).toMatchObject({ unit: 'BOX', ordered: 3, received: 3, remaining: 0 });
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-box-over', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow(/received 3 plus 1 exceeds the ordered 3/);

    // A reversal removes what was put in, in the same unit it was put in with.
    const view = await getMaterialDocument(c, doc.materialDocumentNumber);
    await reverseGoodsReceipt({
      client: c, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      ...POSTING, requestKey: 'req-box-reverse',
    });
    expect(view?.status).toBe('POSTED');
    expect(await onHand()).toMatchObject({ stock: 0, total_stock_quantity: 0, stock_value: 0 });
    expect((await getReceiptOrder(c, order.orderNumber))?.items[0].received).toBe(0);
  });

  it('refuses a receipt whose material no longer carries the conversion, and posts nothing at all', async () => {
    const c = await standingClient();
    await withTenant(c, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${c}, 'MAT-BOX2', 'Loose gaskets', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, overdelivery_tolerance, created_by)
        values (${c}, 'MAT-BOX2', '1000', 0, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                        standard_price, moving_average_price, price_unit, currency, created_by)
        values (${c}, 'MAT-BOX2', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
    });
    await defineUomConversion({
      client: c, changedBy: ACTOR, materialNumber: 'MAT-BOX2', alternativeUnit: 'BOX', numerator: 12, denominator: 1,
    });
    const order = await createOrder({
      client: c, changedBy: ACTOR, ...header,
      items: [{ ...item(2, 50), materialNumber: 'MAT-BOX2', shortText: 'Loose gaskets', unit: 'BOX' }],
    });
    // The conversion is maintained after the order and before the posting: what the receipt must
    // then do is refuse, not assume that a box is a piece.
    await removeUomConversion({
      client: c, changedBy: ACTOR, materialNumber: 'MAT-BOX2', alternativeUnit: 'BOX',
    });
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-box-nofactor', lines: [{ itemNumber: 10, quantity: 2 }],
    })).rejects.toThrow(/no conversion from BOX to its base unit PC/);

    const posted = await withTenant(c, async (tx) => tx.execute(sql`
      select
        (select count(*)::int from material_document_line where client = ${c} and purchase_order_number = ${order.orderNumber}) as lines,
        (select coalesce(sum(quantity), 0)::float8 from stock_quantity where client = ${c} and material_number = 'MAT-BOX2') as stock,
        (select total_stock_quantity::float8 from material_valuation where client = ${c} and material_number = 'MAT-BOX2' and valuation_area = '1000') as valuation_quantity
    `)) as unknown as Array<Record<string, number>>;
    expect(posted[0]).toEqual({ lines: 0, stock: 0, valuation_quantity: 0 });
    // The order still says nothing was received: a refused posting leaves no trace on it.
    expect((await getReceiptOrder(c, order.orderNumber))?.items[0]).toMatchObject({ received: 0, remaining: 2 });
  });

  it('posts the document, stock, valuation and balanced journal in one transaction, idempotently', async () => {
    const c = await standingClient();
    // Below the release threshold: no strategy claims this order.
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(5, 100)] });
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-full-1', lines: [{ itemNumber: 10, quantity: 5 }],
    });
    expect(doc.status).toBe('POSTED');
    expect(doc.lines[0]).toMatchObject({ movementType: 'GOODS_RECEIPT_PO', quantity: '5.000', value: '500.0000' });
    const { stock, valuation } = await stockAndValuation(c);
    expect(Number(stock[0].quantity)).toBe(5);
    expect(Number(valuation.total_stock_quantity)).toBe(5);
    expect(Number(valuation.stock_value)).toBe(500);
    expect(Number(valuation.moving_average_price)).toBe(100);
    expect((await getReceiptOrder(c, order.orderNumber))?.items[0]).toMatchObject({ received: 5, remaining: 0 });

    const journal = await withTenant(c, (tx) => tx.execute(sql`
      select debit_credit, amount_local from journal_entry_line
      where client = ${c} and document_number = ${doc.journalDocumentNumber}
    `));
    const lines = journal as unknown as Array<{ debit_credit: string; amount_local: string }>;
    const debit = lines.filter((l) => l.debit_credit === 'S').reduce((s, l) => s + Number(l.amount_local), 0);
    const credit = lines.filter((l) => l.debit_credit === 'H').reduce((s, l) => s + Number(l.amount_local), 0);
    expect(debit).toBe(500);
    expect(credit).toBe(500);

    // A retried submission returns the standing document; nothing posts twice.
    const replay = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-full-1', lines: [{ itemNumber: 10, quantity: 5 }],
    });
    expect(replay.materialDocumentNumber).toBe(doc.materialDocumentNumber);
    expect(Number((await stockAndValuation(c)).stock[0].quantity)).toBe(5);

    // Open quantity now stands at zero: one more refuses beyond tolerance.
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-over-1', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow('exceeds the ordered 5');
    // And a closed material period refuses on its own rules.
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-08-18', postingDate: '2026-08-18',
      requestKey: 'req-closed-1', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow('material posting period');
  });

  it('refuses an unreleased order, then posts once released; a flagged material refuses', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(10, 150)] });
    expect((await getOrder(c, order.orderNumber))?.releaseStatus).toBe('UNRELEASED');
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-unrel-1', lines: [{ itemNumber: 10, quantity: 10 }],
    })).rejects.toThrow('is not released');

    await withTenant(c, (tx) => tx.execute(sql`
      update document_release set status = 'RELEASED', current_step = 1
      where client = ${c} and document_number = ${order.orderNumber}
    `));
    const doc = await postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-rel-1', lines: [{ itemNumber: 10, quantity: 4 }],
    });
    expect(doc.status).toBe('POSTED');

    // Reversal is a new document; the original is marked, never edited.
    const reversal = await reverseGoodsReceipt({
      client: c, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      ...POSTING, requestKey: 'req-rev-1',
    });
    expect(reversal.reversalOf).toBe(doc.materialDocumentNumber);
    expect((await getMaterialDocument(c, doc.materialDocumentNumber))?.status).toBe('REVERSED');
    expect((await getReceiptOrder(c, order.orderNumber))?.items[0].received).toBe(0);
    await expect(reverseGoodsReceipt({
      client: c, changedBy: ACTOR, materialDocumentNumber: doc.materialDocumentNumber,
      ...POSTING, requestKey: 'req-rev-2',
    })).rejects.toThrow('already been reversed');

    await withTenant(c, (tx) => tx.execute(sql`
      update material_plant set marked_for_deletion = true
      where client = ${c} and material_number = 'MAT-10001' and plant = '1000'
    `));
    await expect(postGoodsReceipt({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey: 'req-flag-1', lines: [{ itemNumber: 10, quantity: 1 }],
    })).rejects.toThrow('flagged for deletion');
  });

  it('posts and reverses through the real actions using the session identity, not forged form ownership fields', async () => {
    const c = await standingClient();
    await withTenant(c, (tx) => tx.execute(sql`
      update material_plant set marked_for_deletion = false
       where client = ${c} and material_number = 'MAT-10001' and plant = '1000'
    `));
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(2, 50)] });
    setSession(authorisedActor);
    const postKey = 'gr-authorised-action';
    const posted = await postGoodsReceiptAction({ ok: false, message: '' }, receiptForm(order.orderNumber, postKey, {
      client: 'ZZZZ', changedBy: 'FORGED_USER', userId: 'forged-user-id',
      companyCode: 'GR2000', plant: 'GR-OTHER',
    }));
    expect(posted.ok, `Action denial: ${posted.message} ${posted.remedy ?? ''}`).toBe(true);
    const documentNumber = posted.documentNumber!;
    const doc = await getMaterialDocument(c, documentNumber);
    expect(doc?.lines[0]).toMatchObject({ plant: '1000', purchaseOrderNumber: order.orderNumber });
    const creator = await withTenant(c, async (tx) => tx.execute(sql`
      select created_by from material_document
       where client = ${c} and material_document_number = ${documentNumber}
    `)) as unknown as Array<{ created_by: string }>;
    expect(creator[0].created_by).toBe('scr061.goods-receipt.authorised');

    setSession(noPlantActor);
    const beforeReplayDenial = await postingSnapshot(c);
    const replayDenial = await postGoodsReceiptAction({ ok: false, message: '' }, receiptForm(order.orderNumber, postKey));
    expect(replayDenial.ok).toBe(false);
    expect(replayDenial.message).toBe('You are not authorised to post this goods receipt.');
    expect(await postingSnapshot(c)).toEqual(beforeReplayDenial);

    const beforeReverseDenial = await postingSnapshot(c);
    const reverseDeniedForm = new FormData();
    reverseDeniedForm.set('materialDocumentNumber', documentNumber);
    reverseDeniedForm.set('documentDate', POSTING.documentDate);
    reverseDeniedForm.set('postingDate', POSTING.postingDate);
    reverseDeniedForm.set('requestKey', 'gr-unauthorised-reversal');
    const reverseDenied = await reverseGoodsReceiptAction({ ok: false, message: '' }, reverseDeniedForm);
    // The document identity is a target only; authority still comes from the session.
    expect(reverseDenied.ok).toBe(false);
    expect(reverseDenied.message).toBe('You are not authorised to post this goods receipt.');
    expect(await postingSnapshot(c)).toEqual(beforeReverseDenial);
    expect((await getMaterialDocument(c, documentNumber))?.status).toBe('POSTED');

    setSession(authorisedActor);
    const reverseForm = new FormData();
    reverseForm.set('materialDocumentNumber', documentNumber);
    reverseForm.set('documentDate', POSTING.documentDate);
    reverseForm.set('postingDate', POSTING.postingDate);
    reverseForm.set('requestKey', 'gr-authorised-reversal');
    const reversed = await reverseGoodsReceiptAction({ ok: false, message: '' }, reverseForm);
    expect(reversed.ok).toBe(true);
    expect((await getMaterialDocument(c, documentNumber))?.status).toBe('REVERSED');
  });

  it('denies a same-company plant, a different company, missing plant ownership, and a PO/plant company mismatch without writes', async () => {
    const c = await standingClient();
    setSession(authorisedActor);
    const before = await postingSnapshot(c);
    for (const [orderNumber, requestKey] of [
      ['GR-SAME-PO', 'gr-deny-same-plant'],
      ['GR-OTHER-PO', 'gr-deny-other-company'],
      ['GR-NOCO-PO', 'gr-deny-missing-plant-company'],
      ['GR-MISMATCH-PO', 'gr-deny-order-plant-mismatch'],
    ]) {
      const result = await postGoodsReceiptAction(
        { ok: false, message: '' }, receiptForm(orderNumber, requestKey),
      );
      expect(result.ok).toBe(false);
      expect(result.message).toBe('You are not authorised to post this goods receipt.');
      expect(await postingSnapshot(c)).toEqual(before);
    }
  });

  it('fails closed for missing authority, invalid sessions, missing assignments, inactive users, forged identities, and cross-client context', async () => {
    const c = await standingClient();
    const order = await createOrder({ client: c, changedBy: ACTOR, ...header, items: [item(2, 50)] });
    const before = await postingSnapshot(c);
    const target = (requestKey: string) => ({
      client: c, changedBy: ACTOR, orderNumber: order.orderNumber, ...POSTING,
      requestKey, lines: [{ itemNumber: 10, quantity: 1 }],
    });
    await expect(postGoodsReceiptRaw(target('gr-invalid-session'), {
      authorization: { userId: authorisedActor.userId, sessionId: randomUUID() },
    })).rejects.toMatchObject({ message: 'You are not authorised to post this goods receipt.' });
    await expect(postGoodsReceiptRaw(target('gr-no-capability'), {
      authorization: { userId: noCapabilityActor.userId, sessionId: noCapabilityActor.sessionId },
    })).rejects.toMatchObject({ message: 'You are not authorised to post this goods receipt.' });
    expect(await postingSnapshot(c)).toEqual(before);

    setSession(undefined);
    await expect(postGoodsReceiptAction({ ok: false, message: '' }, receiptForm(order.orderNumber, 'gr-unauthenticated')))
      .rejects.toThrow(/REDIRECT:\/signin/);
    expect(await postingSnapshot(c)).toEqual(before);

    setSession(noPlantActor);
    const forged = await postGoodsReceiptAction({ ok: false, message: '' }, receiptForm(order.orderNumber, 'gr-forged-identity', {
      client: 'ZZZZ', changedBy: 'SCR061.goods-receipt.authorised',
      userId: authorisedActor.userId, sessionId: authorisedActor.sessionId,
      companyCode: '1000', plant: '1000',
    }));
    expect(forged.ok).toBe(false);
    expect(forged.message).toBe('You are not authorised to post this goods receipt.');
    setSession(noCompanyActor);
    const noCompany = await postGoodsReceiptAction({ ok: false, message: '' }, receiptForm(order.orderNumber, 'gr-missing-company'));
    expect(noCompany.ok).toBe(false);
    expect(noCompany.message).toBe('You are not authorised to post this goods receipt.');
    expect(await postingSnapshot(c)).toEqual(before);

    setSession(authorisedActor);
    await withTenant(c, (tx) => tx.execute(sql`
      update app_user set is_active = false where client = ${c} and id = ${authorisedActor.userId}
    `));
    await expect(postGoodsReceiptRaw(target('gr-inactive-action'), {
      authorization: { userId: authorisedActor.userId, sessionId: authorisedActor.sessionId },
    })).rejects.toMatchObject({ message: 'You are not authorised to post this goods receipt.' });
    await expect(reverseGoodsReceiptRaw({
      client: c, changedBy: ACTOR, materialDocumentNumber: 'missing-document', ...POSTING,
      requestKey: 'gr-inactive-reverse',
    }, { authorization: { userId: authorisedActor.userId, sessionId: authorisedActor.sessionId } }))
      .rejects.toMatchObject({ message: 'You are not authorised to post this goods receipt.' });
    await expect(postGoodsReceiptAction({ ok: false, message: '' }, receiptForm(order.orderNumber, 'gr-inactive-cookie')))
      .rejects.toThrow(/REDIRECT:\/signin/);
    await withTenant(c, (tx) => tx.execute(sql`
      update app_user set is_active = true where client = ${c} and id = ${authorisedActor.userId}
    `));
    expect(await postingSnapshot(c)).toEqual(before);

    const foreign = await createTenant('gr-auth-cross-client');
    foreignClient = foreign.client;
    const foreignBefore = await postingSnapshot(foreignClient);
    await expect(postGoodsReceiptRaw({ ...target('gr-cross-client'), client: foreignClient }, {
      authorization: { userId: authorisedActor.userId, sessionId: authorisedActor.sessionId },
    })).rejects.toMatchObject({ message: 'You are not authorised to post this goods receipt.' });
    expect(await postingSnapshot(foreignClient)).toEqual(foreignBefore);
    expect(await postingSnapshot(c)).toEqual(before);
  });
});
