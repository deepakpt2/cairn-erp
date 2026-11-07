import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { defineRange } from '../src/platform/numbering';
import { createOrder } from '../src/modules/purchasing/orders';
import {
  cancelSupplierInvoice, getInvoiceOrder, postSupplierInvoice,
} from '../src/modules/purchasing/invoice-verification';
import { createAsset, deactivateAsset, getAsset } from '../src/modules/finance/asset-master';
import { getAssetTransactions } from '../src/modules/finance/asset-acquisition';
import { createInternalOrder } from '../src/modules/foundation/internal-order';
import { initializeMaterialPeriodControl } from '../src/modules/inventory/material-period-control';
import { postGoodsReceipt } from './helpers/goods-receipt-authorized';
import { costCenter } from '../src/modules/foundation/schema';
import { createTenant, defineTestRanges, destroyTenant } from './helpers';

/**
 * Account-assigned invoice verification. An item that is charged to a cost
 * centre, an internal order or an asset buys no stock, so it must settle
 * without GR/IR: the value goes where the order says it belongs, and no
 * goods-received balance is left behind to explain. These tests post for
 * real, then read the ledger and the asset subledger back.
 */
const ACTOR = 'IV_ACCT_ASSIGN';
const DATES = { documentDate: '2026-10-18', postingDate: '2026-10-18' };
const GR_IR = '210000';
const EXPENSE = '400000';
const ASSET_RECON = '150000';

let client = '';

beforeAll(async () => {
  const tenant = await createTenant('invoice-account-assignment');
  client = tenant.client;
  await defineTestRanges(tenant, { fiscalYear: 2026 });
  await withTenant(client, async (tx) => {
    await defineRange(tx, { client, objectCode: 'PURCHORD', subObject: 'POF', prefix: 'POF', numberLength: 7, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'MATDOC', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'VENDINV', subObject: '*', prefix: '', numberLength: 10, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'INTORDER', subObject: '*', prefix: 'IO', numberLength: 8, createdBy: ACTOR });
    await defineRange(tx, { client, objectCode: 'ASSETNR', subObject: '*', prefix: 'AS', numberLength: 7, createdBy: ACTOR });
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
      insert into payment_terms (client, terms_code, description, baseline_source, net_days, created_by)
      values (${client}, 'NET30', 'Net 30 days', 'DOCUMENT_DATE', 30, ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_company_code (
        client, partner_number, role_code, company_code, chart_of_accounts,
        reconciliation_account, payment_terms_code, created_by
      )
      values (${client}, 'V10000', 'SUPPLIER', '1000', 'CA01', '200000', 'NET30', ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into tax_code (client, country, tax_code, name, tax_type, rate_percent, created_by)
      values (${client}, 'KW', 'T10', 'Input tax 10 percent', 'VAT', 10, ${ACTOR}) on conflict do nothing
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
             (${client}, 'CA01', 'GR_IR_CLEARING', '', '', ${GR_IR}, ${ACTOR}),
             (${client}, 'CA01', 'PRICE_DIFFERENCE', 'RAW_INVENTORY', '', '410200', ${ACTOR}),
             (${client}, 'CA01', 'TAX', '', '', '140000', ${ACTOR})
      on conflict do nothing
    `);
    // An expense account to charge. It must be a profit-and-loss account: a
    // balance-sheet account is not something a purchase order consumes.
    await tx.execute(sql`
      insert into gl_account (client, chart_of_accounts, account_number, name, account_type,
                              is_balance_sheet, is_open_item_managed, reconciliation_type,
                              requires_cost_object, is_tax_relevant, account_group, gl_account_type, created_by)
      select ${client}, c.chart_of_accounts, v.n, v.d, v.t, v.bs, false, null, v.cost, false, 'GENL',
             case when v.bs then 'BALANCE_SHEET' else 'PL_STATEMENT' end, ${ACTOR}
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      cross join (values
        (${EXPENSE}, 'Consumables expense', 'EXPENSE', false, true),
        (${ASSET_RECON}, 'Fixed asset acquisition', 'ASSET', true, false)
      ) as v(n, d, t, bs, cost)
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into controlling_area_company (client, controlling_area, company_code, created_by)
      values (${client}, 'A000', '1000', ${ACTOR}) on conflict do nothing
    `);
    await tx.execute(sql`
      insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
      values (${client}, 'A000', 'CC1000', '2026-01-01', '2026-12-31', 'Maintenance', 'PRODUCTION', '1000', false, ${ACTOR})
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into internal_order_type (client, order_type, description, number_range_sub_object, statistical_default, created_by)
      values (${client}, 'IO01', 'Internal order', '*', false, ${ACTOR}) on conflict do nothing
    `);
  });
  await initializeMaterialPeriodControl({
    client, changedBy: ACTOR, companyCode: '1000', fiscalYear: 2026, period: 10, reason: 'Account-assigned invoice acceptance',
  });
}, 180_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
}, 180_000);

const header = {
  supplierNumber: 'V10000', purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', currency: '',
};

function item(quantity: number, netPrice: number, extra: Record<string, unknown> = {}) {
  return {
    materialNumber: 'MAT-10001', shortText: 'Industrial steel plate', quantity, unit: 'PC',
    netPrice, priceUnit: 1, taxCode: '', plant: '1000', storageLocation: '',
    markedForDeletion: false,
    scheduleLines: [{ deliveryDate: '2026-11-15', quantity }],
    assignments: [] as never[],
    ...extra,
  };
}

async function newInternalOrder(): Promise<string> {
  const { orderNumber } = await createInternalOrder({
    client, changedBy: ACTOR, orderType: 'IO01', description: 'Overhaul 2026',
    controllingArea: 'A000', companyCode: '1000', startDate: '2026-01-01', endDate: '2026-12-31',
  });
  return orderNumber;
}

async function newAsset(): Promise<string> {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into asset_class (client, asset_class, name, numbering, recon_account, created_by)
      values (${client}, '3000', 'Machinery', 'INTERNAL', ${ASSET_RECON}, ${ACTOR})
      on conflict (client, asset_class) do update set recon_account = excluded.recon_account, is_active = true
    `);
    await tx.execute(sql`
      insert into asset_transaction_type (client, type_code, name, kind, is_active, created_by)
      values (${client}, 'AQ01', 'Acquisition from purchase', 'ACQUISITION', true, ${ACTOR}) on conflict do nothing
    `);
  });
  const [asset] = await createAsset({
    client, changedBy: ACTOR, companyCode: '1000', assetClass: '3000',
    description1: 'Press line', assignment: { validFrom: '2026-01-01' },
  });
  return asset.assetNumber;
}

async function journalLines(documentNumber: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select l.gl_account, l.debit_credit, l.amount_local::float as amount,
             l.cost_center, l.internal_order
        from journal_entry_line l
       where l.client = ${client} and l.document_number = ${documentNumber}
       order by l.line_number
    `);
    return rows as unknown as Array<Record<string, string | number | null>>;
  });
}

describe('account-assigned invoice verification', () => {
  it('charges a cost-centre item to the assigned account and never touches GR/IR', async () => {
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(2, 150, {
        accountAssignmentCategory: 'COST_CENTER',
        assignments: [{ glAccount: EXPENSE, costCenter: 'CC1000', distributionPercentage: 100 }],
      })],
    });

    // No goods receipt is posted, and none is needed: the item consumes nothing.
    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-CC-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 330, requestKey: 'iv-cc-1',
      lines: [{ itemNumber: 10, quantity: 2, netAmount: 300, taxCode: 'T10' }],
    });
    expect(invoice.status).toBe('POSTED');

    const lines = await journalLines(invoice.journalDocumentNumber!);
    const debit = lines.find((l) => l.gl_account === EXPENSE);
    expect(debit).toMatchObject({ debit_credit: 'S', amount: 300, cost_center: 'CC1000' });
    // The whole point: no GR/IR line is written, so no balance is left to explain.
    expect(lines.some((l) => l.gl_account === GR_IR)).toBe(false);
    expect(lines.some((l) => l.gl_account === '120000')).toBe(false);
    const credit = lines.find((l) => l.gl_account === '200000');
    expect(credit).toMatchObject({ debit_credit: 'H', amount: 330 });

    // Eligibility reads as an account-assigned item: the order quantity is invoiceable,
    // because the consumption is what the order bought, not a receipt of stock.
    const view = await getInvoiceOrder(client, order.orderNumber);
    expect(view?.items[0]).toMatchObject({ invoiceable: 0, invoiced: 2, received: 0 });
  });

  it('carries an internal order onto the line and posts no GR/IR', async () => {
    const internalOrder = await newInternalOrder();
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 500, {
        accountAssignmentCategory: 'ORDER',
        assignments: [{ glAccount: EXPENSE, internalOrder, distributionPercentage: 100 }],
      })],
    });
    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-IO-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 550, requestKey: 'iv-io-1',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 500, taxCode: 'T10' }],
    });
    const lines = await journalLines(invoice.journalDocumentNumber!);
    expect(lines.find((l) => l.gl_account === EXPENSE))
      .toMatchObject({ debit_credit: 'S', amount: 500, internal_order: internalOrder });
    expect(lines.some((l) => l.gl_account === GR_IR)).toBe(false);
  });

  it('splits one item across two cost centres and the parts sum to the charge', async () => {
    await withTenant(client, async (tx) => {
      await tx.execute(sql`
        insert into cost_center (client, controlling_area, cost_center, valid_from, valid_to, name, category, company_code, is_posting_locked, created_by)
        values (${client}, 'A000', 'CC2000', '2026-01-01', '2026-12-31', 'Overhead', 'PRODUCTION', '1000', false, ${ACTOR})
        on conflict do nothing
      `);
    });
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(3, 100, {
        accountAssignmentCategory: 'COST_CENTER',
        assignments: [
          { glAccount: EXPENSE, costCenter: 'CC1000', distributionPercentage: 60 },
          { glAccount: EXPENSE, costCenter: 'CC2000', distributionPercentage: 40 },
        ],
      })],
    });
    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-SPLIT-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 330, requestKey: 'iv-split-1',
      lines: [{ itemNumber: 10, quantity: 3, netAmount: 300, taxCode: 'T10' }],
    });
    const lines = await journalLines(invoice.journalDocumentNumber!);
    const charges = lines.filter((l) => l.gl_account === EXPENSE);
    expect(charges).toHaveLength(2);
    expect(charges.reduce((s, l) => s + Number(l.amount), 0)).toBe(300);
    expect(charges.map((l) => Number(l.amount)).sort()).toEqual([120, 180]);
    expect(charges.map((l) => l.cost_center).sort()).toEqual(['CC1000', 'CC2000']);
  });

  it('refuses an internal order on an item assigned to a cost centre, and the other way about', async () => {
    const internalOrder = await newInternalOrder();
    // The category is the item's: it names one kind of object, and every row under it
    // names that kind. A row naming another is not a second opinion — it contradicts.
    await expect(createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 100, {
        accountAssignmentCategory: 'COST_CENTER',
        assignments: [{ glAccount: EXPENSE, internalOrder, distributionPercentage: 100 }],
      })],
    })).rejects.toThrow(/must name a cost centre and no other object/);

    await expect(createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 100, {
        accountAssignmentCategory: 'ORDER',
        assignments: [{ glAccount: EXPENSE, costCenter: 'CC1000', distributionPercentage: 100 }],
      })],
    })).rejects.toThrow(/must name an internal order and no other object/);

    // An asset row under either consumption category is refused the same way.
    await expect(createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 100, {
        accountAssignmentCategory: 'COST_CENTER',
        assignments: [{ glAccount: EXPENSE, assetNumber: 'AS0000001', assetTransactionType: 'AQ01', distributionPercentage: 100 }],
      })],
    })).rejects.toThrow(/must name a cost centre and no other object/);
  });

  it('capitalizes an asset item on the class reconciliation account and writes the asset subledger', async () => {
    const assetNumber = await newAsset();
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 4000, {
        accountAssignmentCategory: 'ASSET',
        assignments: [{
          glAccount: EXPENSE, assetNumber, assetTransactionType: 'AQ01', distributionPercentage: 100,
        }],
      })],
    });
    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-AS-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 4400, requestKey: 'iv-as-1',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 4000, taxCode: 'T10' }],
    });

    const lines = await journalLines(invoice.journalDocumentNumber!);
    // The asset's own account comes from its class, not from whatever account the buyer typed.
    expect(lines.find((l) => l.gl_account === ASSET_RECON))
      .toMatchObject({ debit_credit: 'S', amount: 4000 });
    expect(lines.some((l) => l.gl_account === EXPENSE)).toBe(false);
    expect(lines.some((l) => l.gl_account === GR_IR)).toBe(false);

    // One journal, one supplier credit. Capitalizing does not post a second document.
    expect(lines.filter((l) => l.gl_account === '200000')).toHaveLength(1);
    expect(Number(lines.find((l) => l.gl_account === '200000')?.amount)).toBe(4400);

    const txns = await getAssetTransactions(client, '1000', assetNumber, '0000');
    expect(txns).toEqual([expect.objectContaining({
      status: 'ACTIVE', amount: 4000, transactionType: 'AQ01',
      documentNumber: invoice.journalDocumentNumber, offsetAccount: '200000',
    })]);
    const asset = await getAsset(client, '1000', assetNumber, '0000');
    expect(asset?.capitalizationDate).toBe('2026-10-18');
  });

  it('takes the capitalization off the asset when the invoice is cancelled', async () => {
    const assetNumber = await newAsset();
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 4000, {
        accountAssignmentCategory: 'ASSET',
        assignments: [{
          glAccount: EXPENSE, assetNumber, assetTransactionType: 'AQ01', distributionPercentage: 100,
        }],
      })],
    });
    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-AS-2', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 4400, requestKey: 'iv-as-2',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 4000, taxCode: 'T10' }],
    });
    const cancelled = await cancelSupplierInvoice({
      client, changedBy: ACTOR, invoiceNumber: invoice.invoiceNumber,
      postingDate: '2026-10-19', requestKey: 'iv-as-2-cancel',
    });

    const txns = await getAssetTransactions(client, '1000', assetNumber, '0000');
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      status: 'REVERSED', reversalDocumentNumber: cancelled.journalDocumentNumber, amount: 4000,
    });

    // One mirror, not two: the cancellation credits the supplier once and debits back
    // the asset and the tax. Capitalizing does not add a second document to reverse.
    const lines = await journalLines(cancelled.journalDocumentNumber!);
    expect(lines.filter((l) => l.gl_account === '200000')).toHaveLength(1);
    expect(lines.find((l) => l.gl_account === '200000')).toMatchObject({ debit_credit: 'S', amount: 4400 });
    expect(lines.find((l) => l.gl_account === ASSET_RECON)).toMatchObject({ debit_credit: 'H', amount: 4000 });
    expect(lines.find((l) => l.gl_account === '140000')).toMatchObject({ debit_credit: 'H', amount: 400 });
  });

  it('settles a mixed order: stock through GR/IR, an assigned item beside it', async () => {
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [
        item(5, 100, { grBasedInvoiceVerification: true }),
        item(2, 150, {
          accountAssignmentCategory: 'COST_CENTER',
          assignments: [{ glAccount: EXPENSE, costCenter: 'CC1000', distributionPercentage: 100 }],
        }),
      ],
    });
    await postGoodsReceipt({
      client, changedBy: ACTOR, orderNumber: order.orderNumber, ...DATES,
      requestKey: 'iv-mixed-gr', lines: [{ itemNumber: 10, quantity: 5 }],
    });

    const invoice = await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-MIX-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 880, requestKey: 'iv-mixed-1',
      lines: [
        { itemNumber: 10, quantity: 5, netAmount: 500, taxCode: 'T10' },
        { itemNumber: 20, quantity: 2, netAmount: 300, taxCode: 'T10' },
      ],
    });
    const lines = await journalLines(invoice.journalDocumentNumber!);
    // The stock item clears GR/IR; the assigned item goes to its expense. Both in one document.
    expect(lines.find((l) => l.gl_account === GR_IR)).toMatchObject({ debit_credit: 'S', amount: 500 });
    expect(lines.find((l) => l.gl_account === EXPENSE))
      .toMatchObject({ debit_credit: 'S', amount: 300, cost_center: 'CC1000' });
    expect(lines.find((l) => l.gl_account === '200000')).toMatchObject({ debit_credit: 'H', amount: 880 });
  });

  it('refuses when the assignment no longer stands at the posting date', async () => {
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 100, {
        accountAssignmentCategory: 'COST_CENTER',
        assignments: [{ glAccount: EXPENSE, costCenter: 'CC1000', distributionPercentage: 100 }],
      })],
    });
    await withTenant(client, async (tx) => {
      await tx.update(costCenter).set({ isPostingLocked: true, changedBy: ACTOR })
        .where(sql`${costCenter.client} = ${client} and ${costCenter.costCenter} = 'CC1000'`);
    });
    await expect(postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-LOCKED-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 110, requestKey: 'iv-locked-1',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 100, taxCode: 'T10' }],
    })).rejects.toThrow(/locked|does not stand/i);
    await withTenant(client, async (tx) => {
      await tx.update(costCenter).set({ isPostingLocked: false, changedBy: ACTOR })
        .where(sql`${costCenter.client} = ${client} and ${costCenter.costCenter} = 'CC1000'`);
    });
  });

  it('refuses an asset that has been deactivated since the order was placed', async () => {
    const assetNumber = await newAsset();
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(1, 1000, {
        accountAssignmentCategory: 'ASSET',
        assignments: [{ glAccount: EXPENSE, assetNumber, assetTransactionType: 'AQ01', distributionPercentage: 100 }],
      })],
    });
    const standing = await getAsset(client, '1000', assetNumber, '0000');
    await deactivateAsset({
      client, changedBy: ACTOR, companyCode: '1000', assetNumber, subNumber: '0000',
      expectedVersion: standing!.version, deactivationDate: '2026-10-15', reason: 'Taken out of service',
    });
    await expect(postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-AS-OFF', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 1100, requestKey: 'iv-as-off',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 1000, taxCode: 'T10' }],
    })).rejects.toThrow(/not active|deactivated|does not stand/i);
  });

  it('keeps the ordinary controls: nothing beyond the invoiceable quantity', async () => {
    const order = await createOrder({
      client, changedBy: ACTOR, ...header,
      items: [item(2, 100, {
        accountAssignmentCategory: 'COST_CENTER',
        assignments: [{ glAccount: EXPENSE, costCenter: 'CC1000', distributionPercentage: 100 }],
      })],
    });
    await postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-QTY-1', invoiceDate: '2026-10-16', postingDate: '2026-10-18',
      grossAmount: 220, requestKey: 'iv-qty-1',
      lines: [{ itemNumber: 10, quantity: 2, netAmount: 200, taxCode: 'T10' }],
    });
    await expect(postSupplierInvoice({
      client, changedBy: ACTOR, orderNumber: order.orderNumber,
      supplierReference: 'INV-QTY-2', invoiceDate: '2026-10-17', postingDate: '2026-10-18',
      grossAmount: 110, requestKey: 'iv-qty-2',
      lines: [{ itemNumber: 10, quantity: 1, netAmount: 100, taxCode: 'T10' }],
    })).rejects.toThrow(/nothing left|invoiceable|exceed/i);
  });
});
