import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import { releaseDocument } from '../src/modules/purchasing/release';
import { createRequestForQuotation, getRequestForQuotation } from '../src/modules/purchasing/rfq';
import { createQuotation, getQuotation } from '../src/modules/purchasing/quotation';
import { createPurchasingInfoRecord } from '../src/modules/purchasing/info-record';

import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { postSupplierInvoice } from '../src/modules/purchasing/invoice-verification';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { defineTestRanges } from './helpers';
import {
  PurchaseContractError,
  changePurchaseContract,
  createPurchaseContract,
  getPurchaseContract,
} from '../src/modules/purchasing/contract';
import { openPurchaseContractDisplay } from '../src/modules/purchasing/contract-display';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'CONTRACT_TEST';
const clients: string[] = [];

afterAll(async () => {
  for (const client of clients) await destroyTenant(client);
  await closeDb();
});

async function standing(seed: string): Promise<string> {
  const tenant = await createTenant(seed);
  clients.push(tenant.client);
  const client = tenant.client;
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'PURCHCONT', subObject: '*', prefix: '46', numberLength: 10, createdBy: ACTOR });
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
      values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
      values (${client}, '1000', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, category, name, created_by)
      values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into bp_role (client, partner_number, role_code, created_by)
      values (${client}, 'V10000', 'SUPPLIER', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, created_by)
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      values (${client}, 'MAT-CONT', 'Contract material', 'RAW', 'PC', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      values (${client}, 'MAT-CONT', '1000', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_contract_type (client, document_type, description, category, created_by)
      values (${client}, 'Q1', 'Test quantity contract', 'QUANTITY', ${ACTOR}),
             (${client}, 'V1', 'Test value contract', 'VALUE', ${ACTOR})
      on conflict do nothing
    `);
  });
  return client;
}

function header(type = 'Q1') {
  return {
    documentType: type,
    supplierNumber: 'V10000',
    purchasingOrg: '1000',
    purchasingGroup: '001',
    companyCode: '1000',
    currency: 'USD',
    validityStart: '2026-01-01',
    validityEnd: '2026-12-31',
  };
}

describe('purchase contract', () => {
  it('creates a quantity contract without a plant and does not post stock or accounting', async () => {
    const client = await standing('me31k-qty');
    const before = await withTenant(client, async (tx) => {
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return { docs: Number(docs.n), journals: Number(journals.n) };
    });
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-CONT', targetQuantity: 10, unit: 'PC', netPrice: 5 }],
    });
    const document = await getPurchaseContract(client, saved.contractNumber);
    expect(document?.category).toBe('QUANTITY');
    expect(document?.items[0].plant).toBeNull();
    expect(document?.items[0].targetQuantity).toBe('10.000');
    expect(document?.items[0].calledOffQuantity).toBe('0.000');
    expect(document?.releaseStatus).toBe('NOT_REQUIRED');
    const after = await withTenant(client, async (tx) => {
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      const [journals] = await tx.execute(sql`select count(*)::int as n from journal_entry where client = ${client}`) as unknown as Array<{ n: number }>;
      return { docs: Number(docs.n), journals: Number(journals.n) };
    });
    expect(after).toEqual(before);
  });

  it('uses a configured type and refuses a type that is not configured', async () => {
    const client = await standing('me31k-type');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchasing_contract_type (client, document_type, description, category, created_by)
        values (${client}, 'MK', 'Quantity contract', 'QUANTITY', ${ACTOR})
        on conflict do nothing
      `);
    });
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header('MK'),
      items: [{ shortText: 'Steel', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    });
    expect((await getPurchaseContract(client, saved.contractNumber))?.category).toBe('QUANTITY');
    await expect(createPurchaseContract({
      client, changedBy: ACTOR, ...header('ZZ'),
      items: [{ shortText: 'Steel', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    })).rejects.toBeInstanceOf(PurchaseContractError);
  });

  it('returns the same contract for the same request key and does not change a copied source', async () => {
    const client = await standing('me31k-copy');
    const first = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(), requestKey: 'same-key',
      items: [{ shortText: 'Steel', targetQuantity: 8, unit: 'PC', netPrice: 4 }],
    });
    const replay = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(), requestKey: 'same-key',
      items: [{ shortText: 'Other', targetQuantity: 1, unit: 'PC', netPrice: 9 }],
    });
    expect(replay.contractNumber).toBe(first.contractNumber);
    const copy = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(), sourceContractNumber: first.contractNumber, items: [],
    });
    const source = await getPurchaseContract(client, first.contractNumber);
    const copied = await getPurchaseContract(client, copy.contractNumber);
    expect(source?.items[0].targetQuantity).toBe('8.000');
    expect(copied?.sourceContractNumber).toBe(first.contractNumber);
    expect(copied?.contractNumber).not.toBe(first.contractNumber);
  });

  it('consumes a quantity contract from a saved purchase order and refuses the excess', async () => {
    const client = await standing('me31k-call');
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-CONT', shortText: 'Contract material', targetQuantity: 10, unit: 'PC', netPrice: 5, plant: '1000' }],
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 6, unit: 'PC', netPrice: 5,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 6 }],
      }],
    });
    const document = await getPurchaseContract(client, saved.contractNumber);
    expect(document?.items[0].calledOffQuantity).toBe('6.000');
    expect(document?.items[0].remainingQuantity).toBe('4.000');
    expect(order.orderNumber).toBeTruthy();
    await expect(createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 5, unit: 'PC', netPrice: 5,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 5 }],
      }],
    })).rejects.toThrow(/exceeds target quantity/);
    const still = await getPurchaseContract(client, saved.contractNumber);
    expect(still?.items[0].calledOffQuantity).toBe('6.000');
  });

  it('holds a value contract to the header target and keeps item value from being the commitment', async () => {
    const client = await standing('me31k-value');
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header('V1'), targetValue: 100,
      items: [{ shortText: 'Open value', netPrice: 10 }],
    });
    expect(saved.warnings.some((warning) => warning.includes('exceed the header target'))).toBe(false);
    const overItems = await createPurchaseContract({
      client, changedBy: ACTOR, ...header('V1'), targetValue: 50,
      items: [{ shortText: 'Above header', netPrice: 80, targetQuantity: 1, unit: 'PC' }],
    });
    expect(overItems.warnings.some((warning) => warning.includes('exceed the header target'))).toBe(true);
    await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 6, unit: 'PC', netPrice: 10,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 6 }],
      }],
    });
    await expect(createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 5, unit: 'PC', netPrice: 10,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 5 }],
      }],
    })).rejects.toThrow(/exceeds target value/);
  });

  it('does not consume a requisition and refuses a call-off while release is pending', async () => {
    const client = await standing('me31k-ref');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into purchase_requisition_item (
          client, requisition_number, item_number, short_text, quantity, unit,
          requisition_date, delivery_date, plant, purchasing_group, created_by
        ) values (
          ${client}, '1000000001', 10, 'From requisition', 4, 'PC',
          '2026-10-01', '2026-10-30', '1000', '001', ${ACTOR}
        )
      `);
      await tx.execute(sql`
        insert into characteristic (client, characteristic_name, description, data_format, value_length, decimal_places, lifecycle_status, created_by)
        values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_type (client, class_type, description, object_category, created_by)
        values (${client}, 'PURCHASE_CONTRACT', 'Contract release classes', 'PURCHASING', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
        values (${client}, 'PURCHASE_CONTRACT', 'CT_RELEASE', 'Contract release', 'ACTIVE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
        values (${client}, 'PURCHASE_CONTRACT', 'CT_RELEASE', 1, 'TOTAL_VALUE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into release_group (client, group_code, document_category, description, created_by)
        values (${client}, 'CT', 'PURCHASE_CONTRACT', 'Contract releases', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_code (client, group_code, code, description, created_by)
        values (${client}, 'CT', 'MGR', 'Contract manager', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy (client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by)
        values (${client}, 'CT', 'ALL', 'All contracts', 'PURCHASE_CONTRACT', 'CT_RELEASE', 100, 'ACTIVE', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy_criterion (client, group_code, strategy_code, characteristic_name, operator, value_from, created_by)
        values (${client}, 'CT', 'ALL', 'TOTAL_VALUE', 'GE', '0', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
        values (${client}, 'CT', 'ALL', 1, 'MGR', ${ACTOR})
      `);
    });
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ requisitionNumber: '1000000001', requisitionItem: 10, netPrice: 3 }],
    });
    const quantity = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select quantity from purchase_requisition_item
         where client = ${client} and requisition_number = '1000000001' and item_number = 10
      `) as unknown as Array<{ quantity: string }>;
      return String(row.quantity);
    });
    expect(quantity).toBe('4.000');
    const document = await getPurchaseContract(client, saved.contractNumber);
    expect(document?.items[0].requisitionNumber).toBe('1000000001');
    expect(document?.releaseStatus).toBe('PENDING');
    await expect(createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 1, unit: 'PC', netPrice: 3,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 1 }],
      }],
    })).rejects.toThrow(/waiting for release/);
    await releaseDocument({
      client, changedBy: ACTOR, documentCategory: 'PURCHASE_CONTRACT',
      documentNumber: saved.contractNumber, releaseCode: 'MGR',
    });
    const released = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 1, unit: 'PC', netPrice: 3,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 1 }],
      }],
    });
    expect(released.orderNumber).toBeTruthy();
  });

  it('does not show another tenant a contract', async () => {
    const client = await standing('me31k-iso');
    const other = await standing('me31k-iso-b');
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Private', targetQuantity: 1, unit: 'PC', netPrice: 1 }],
    });
    expect(await getPurchaseContract(other, saved.contractNumber)).toBeNull();
  });

  it('refuses a target quantity below the called-off quantity', async () => {
    const client = await standing('me31k-change');
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000', materialNumber: 'MAT-CONT' }],
    });
    await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Steel', quantity: 4, unit: 'PC', netPrice: 2,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 4 }],
      }],
    });
    await expect(changePurchaseContract({
      client, changedBy: ACTOR, ...header(), contractNumber: saved.contractNumber,
      items: [{ itemNumber: 10, shortText: 'Steel', targetQuantity: 3, unit: 'PC', netPrice: 2, plant: '1000', materialNumber: 'MAT-CONT' }],
    })).rejects.toThrow(/below the called-off quantity/);
  });

  it('copies an RFQ and quotation without changing either source', async () => {
    const tenant = await createTenant('me31k-rfq');
    clients.push(tenant.client);
    const client = tenant.client;
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHCONT', subObject: '*', prefix: '46', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQEVENT', subObject: '*', prefix: 'EV', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'RFQ', subObject: '*', prefix: 'RQ', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'QUOTATION', subObject: '*', prefix: 'QT', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
        values (${client}, '1000', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', 'CREATED', ${ACTOR})
        on conflict (client, partner_number) do update set general_status = excluded.general_status
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_status, created_by)
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', 'CREATED', ${ACTOR})
        on conflict (client, partner_number, purchasing_org) do update set purchasing_status = excluded.purchasing_status
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-CONT', 'Contract material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'MAT-CONT', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_contract_type (client, document_type, description, category, created_by)
        values (${client}, 'Q1', 'Test quantity contract', 'QUANTITY', ${ACTOR}) on conflict do nothing
      `);
    });
    const request = await createRequestForQuotation({
      client, changedBy: ACTOR, purchasingOrg: '1000', purchasingGroup: '001',
      rfqDate: '2026-10-01', quotationDeadline: '2026-12-31', currency: 'USD',
      suppliers: [{ partnerNumber: 'V10000' }],
      lines: [{ materialNumber: 'MAT-CONT', quantity: 9, unit: 'PC', plant: '1000', deliveryDate: '2026-11-01' }],
    });
    const opened = await getRequestForQuotation(client, request.eventNumber);
    const rfqNumber = opened?.requests[0].rfqNumber ?? '';
    const quotation = await createQuotation({
      client, changedBy: ACTOR, rfqNumber,
      lines: [{ itemNumber: 10, quantity: 9, unit: 'PC', netPrice: 7.5, priceUnit: 1, deliveryDate: '2026-11-15' }],
    });
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ rfqNumber, rfqItem: 10, quotationNumber: quotation.quotationNumber, quotationItem: 10 }],
    });
    const document = await getPurchaseContract(client, saved.contractNumber);
    expect(document?.items[0]).toMatchObject({
      rfqNumber, quotationNumber: quotation.quotationNumber, netPrice: '7.50', targetQuantity: '9.000', plant: '1000',
    });
    const sourceRequest = await getRequestForQuotation(client, request.eventNumber);
    expect(sourceRequest?.requests[0].lines[0].quantity).toBe('9.000');
    const sourceQuotation = await getQuotation(client, quotation.quotationNumber);
    expect(sourceQuotation?.lines[0].netPrice).toBe('7.5000');
  });

  it('fills an omitted price from the info record and keeps a receipt distinct from the call-off', async () => {
    const tenant = await createTenant('me31k-down');
    clients.push(tenant.client);
    const client = tenant.client;
    await defineTestRanges(tenant, { fiscalYear: 2026 });
    await withTenant(client, async (tx) => {
      await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'PURCHCONT', subObject: '*', prefix: '46', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
      await defineRange(tx, { client, objectCode: 'INFOREC', subObject: '*', prefix: 'IR', numberLength: 7, createdBy: ACTOR });
      await tx.execute(sql`
        insert into purchasing_org (client, purchasing_org, name, company_code, created_by)
        values (${client}, '1000', 'Test purchasing organization', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_org_plant (client, purchasing_org, plant, created_by)
        values (${client}, '1000', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into business_partner (client, partner_number, category, name, general_status, created_by)
        values (${client}, 'V10000', 'ORGANIZATION', 'Test Supplier', 'CREATED', ${ACTOR})
        on conflict (client, partner_number) do update set general_status = excluded.general_status
      `);
      await tx.execute(sql`
        insert into bp_role (client, partner_number, role_code, created_by)
        values (${client}, 'V10000', 'SUPPLIER', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_purchasing_org (client, partner_number, role_code, purchasing_org, order_currency, purchasing_status, created_by)
        values (${client}, 'V10000', 'SUPPLIER', '1000', 'USD', 'CREATED', ${ACTOR})
        on conflict (client, partner_number, purchasing_org) do update set purchasing_status = excluded.purchasing_status
      `);
      await tx.execute(sql`
        insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
        values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into supplier_company_code (
          client, partner_number, role_code, company_code, chart_of_accounts,
          reconciliation_account, payment_terms_code, created_by
        ) values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-CONT', 'Contract material', 'RAW', 'PC', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'MAT-CONT', '1000', ${ACTOR}) on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_valuation (
          client, material_number, valuation_area, valuation_class, price_control,
          standard_price, moving_average_price, price_unit, currency, created_by
        ) values (${client}, 'MAT-CONT', '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE', 0, 0, 1, 'USD', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into account_determination (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
        values (${client}, 'CA01', 'INVENTORY', 'RAW_INVENTORY', '', '120000', ${ACTOR}),
               (${client}, 'CA01', 'GR_IR_CLEARING', '', '', '210000', ${ACTOR}),
               (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into purchasing_contract_type (client, document_type, description, category, created_by)
        values (${client}, 'Q1', 'Test quantity contract', 'QUANTITY', ${ACTOR}) on conflict do nothing
      `);
    });
    await initializeMaterialPeriodControl({
      client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Contract downstream',
    });
    await createPurchasingInfoRecord({
      client, changedBy: ACTOR, partnerNumber: 'V10000', materialNumber: 'MAT-CONT', purchasingOrg: '1000', plant: '1000',
      price: { amount: 6, currency: 'USD', priceUnit: 1, priceUnitOfMeasure: 'PC', validFrom: '2026-01-01', validTo: '2026-12-31' },
    });
    const before = await withTenant(client, async (tx) => {
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      return Number(docs.n);
    });
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ materialNumber: 'MAT-CONT', targetQuantity: 10, unit: 'PC', plant: '1000' }],
    });
    const created = await getPurchaseContract(client, saved.contractNumber);
    expect(created?.items[0].netPrice).toBe('6.00');
    expect(saved.warnings.some((warning) => warning.includes('Info record'))).toBe(true);
    const afterCreate = await withTenant(client, async (tx) => {
      const [docs] = await tx.execute(sql`select count(*)::int as n from material_document where client = ${client}`) as unknown as Array<{ n: number }>;
      return Number(docs.n);
    });
    expect(afterCreate).toBe(before);
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Contract material', quantity: 4, unit: 'PC', netPrice: 6,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 4 }],
      }],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      documentDate: '2026-10-23', postingDate: '2026-10-23', requestKey: 'me31k-gr',
      lines: [{ itemNumber: 10, quantity: 2 }],
    });
    await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, supplierReference: 'C-1',
      invoiceDate: '2026-10-23', postingDate: '2026-10-23', grossAmount: 12, requestKey: 'me31k-iv',
      lines: [{ itemNumber: 10, quantity: 2, netAmount: 12 }],
    });
    const document = await getPurchaseContract(client, saved.contractNumber);
    expect(document?.items[0].calledOffQuantity).toBe('4.000');
    expect(document?.items[0].remainingQuantity).toBe('6.000');
    expect(document?.items[0].goodsReceiptQuantity).toBe('2.000');
    expect(document?.items[0].invoiceValue).toBe('12.00');
  });

  it('changes the price without rewriting the purchase order and records the old and new price', async () => {
    const client = await standing('me32k-px');
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 2, plant: '1000', materialNumber: 'MAT-CONT' }],
    });
    const order = await createOrder({
      client, changedBy: ACTOR, supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001',
      companyCode: '1000', currency: 'USD',
      items: [{
        materialNumber: 'MAT-CONT', shortText: 'Steel', quantity: 4, unit: 'PC', netPrice: 2,
        plant: '1000', contractNumber: saved.contractNumber, contractItem: 10,
        scheduleLines: [{ deliveryDate: '2026-10-30', quantity: 4 }],
      }],
    });
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into material (client, material_number, description, material_type, base_unit, created_by)
        values (${client}, 'MAT-ALT', 'Other material', 'RAW', 'PC', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into material_plant (client, material_number, plant, created_by)
        values (${client}, 'MAT-ALT', '1000', ${ACTOR})
        on conflict do nothing
      `);
    });
    await expect(changePurchaseContract({
      client, changedBy: ACTOR, ...header(), contractNumber: saved.contractNumber,
      items: [{ itemNumber: 10, shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 9, plant: '1000', materialNumber: 'MAT-ALT' }],
    })).rejects.toThrow(/material cannot change/);
    await changePurchaseContract({
      client, changedBy: ACTOR, ...header(), contractNumber: saved.contractNumber,
      items: [{ itemNumber: 10, shortText: 'Steel', targetQuantity: 10, unit: 'PC', netPrice: 9, plant: '1000', materialNumber: 'MAT-CONT' }],
    });
    const document = await getPurchaseContract(client, saved.contractNumber);
    expect(document?.items[0].netPrice).toBe('9.00');
    const unchanged = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select net_price, material_number from purchase_order_item
         where client = ${client} and order_number = ${order.orderNumber} and item_number = 10
      `) as unknown as Array<{ net_price: string; material_number: string }>;
      const [history] = await tx.execute(sql`
        select i.old_value, i.new_value, d.transaction_code
          from change_document d
          join change_document_item i on i.client = d.client and i.change_document_id = d.id
         where d.client = ${client} and d.object_class = 'purchase_contract'
           and d.object_key = ${saved.contractNumber} and i.field_name = 'item10Price'
      `) as unknown as Array<{ old_value: string; new_value: string; transaction_code: string }>;
      return { price: String(row.net_price), material: String(row.material_number), history };
    });
    expect(unchanged.price).toBe('2.00');
    expect(unchanged.material).toBe('MAT-CONT');
    expect(unchanged.history.old_value).toBe('2.00');
    expect(unchanged.history.new_value).toBe('9.00');
    expect(unchanged.history.transaction_code).toBe('ME32K');
  });

  it('displays a contract without writing and refuses a display-mode change', async () => {
    const client = await standing('me33k-show');
    const other = await standing('me33k-hide');
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Shown', targetQuantity: 5, unit: 'PC', netPrice: 4 }],
    });
    const before = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select changed_at from purchase_contract where client = ${client} and contract_number = ${saved.contractNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      return row.changed_at;
    });
    const refused = await openPurchaseContractDisplay(client, { contract: saved.contractNumber, netPrice: '1' });
    expect(refused.refusal?.message).toMatch(/price change/i);
    expect(refused.document).toBeNull();
    const opened = await openPurchaseContractDisplay(client, { contract: saved.contractNumber });
    expect(opened.document?.items[0].netPrice).toBe('4.00');
    expect(opened.document?.items[0].calledOffQuantity).toBe('0.000');
    const hidden = await openPurchaseContractDisplay(other, { contract: saved.contractNumber });
    expect(hidden.document).toBeNull();
    expect(hidden.refusal?.message).toMatch(/does not exist/);
    const after = await withTenant(client, async (tx) => {
      const [row] = await tx.execute(sql`
        select changed_at from purchase_contract where client = ${client} and contract_number = ${saved.contractNumber}
      `) as unknown as Array<{ changed_at: Date | null }>;
      return row.changed_at;
    });
    expect(after).toEqual(before);
  });

  it('refuses a change after the contract is released', async () => {
    const client = await standing('me32k-hold');
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into characteristic (client, characteristic_name, description, data_format, value_length, decimal_places, lifecycle_status, created_by)
        values (${client}, 'TOTAL_VALUE', 'Total document value', 'NUM', 13, 2, 'ACTIVE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_type (client, class_type, description, object_category, created_by)
        values (${client}, 'PURCHASE_CONTRACT', 'Contract release classes', 'PURCHASING', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into classification_class (client, class_type, class_name, description, lifecycle_status, created_by)
        values (${client}, 'PURCHASE_CONTRACT', 'CT_RELEASE', 'Contract release', 'ACTIVE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into class_assignment (client, class_type, class_name, position, characteristic_name, created_by)
        values (${client}, 'PURCHASE_CONTRACT', 'CT_RELEASE', 1, 'TOTAL_VALUE', ${ACTOR})
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into release_group (client, group_code, document_category, description, created_by)
        values (${client}, 'CT', 'PURCHASE_CONTRACT', 'Contract releases', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_code (client, group_code, code, description, created_by)
        values (${client}, 'CT', 'MGR', 'Contract manager', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy (client, group_code, strategy_code, description, class_type, class_name, priority, lifecycle_status, created_by)
        values (${client}, 'CT', 'ALL', 'All contracts', 'PURCHASE_CONTRACT', 'CT_RELEASE', 100, 'ACTIVE', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy_criterion (client, group_code, strategy_code, characteristic_name, operator, value_from, created_by)
        values (${client}, 'CT', 'ALL', 'TOTAL_VALUE', 'GE', '0', ${ACTOR})
      `);
      await tx.execute(sql`
        insert into release_strategy_step (client, group_code, strategy_code, step, release_code, created_by)
        values (${client}, 'CT', 'ALL', 1, 'MGR', ${ACTOR})
      `);
    });
    const saved = await createPurchaseContract({
      client, changedBy: ACTOR, ...header(),
      items: [{ shortText: 'Held', targetQuantity: 2, unit: 'PC', netPrice: 1 }],
    });
    await releaseDocument({
      client, changedBy: ACTOR, documentCategory: 'PURCHASE_CONTRACT',
      documentNumber: saved.contractNumber, releaseCode: 'MGR',
    });
    await expect(changePurchaseContract({
      client, changedBy: ACTOR, ...header(), contractNumber: saved.contractNumber,
      items: [{ itemNumber: 10, shortText: 'Held', targetQuantity: 2, unit: 'PC', netPrice: 8 }],
    })).rejects.toBeInstanceOf(PurchaseContractError);
  });
});
