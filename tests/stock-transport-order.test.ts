import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { createOrderForProvisioning as createOrder, changeOrderForProvisioning as changeOrder, getOrderForProvisioning as getOrder } from '../src/modules/purchasing/orders';
import {
  StockTransportError, getStoStatus, postStoIssue, postStoReceipt, reconcileStoItem, reverseStoDocument,
} from '../src/modules/inventory/stock-transport';
import { makeStoActor } from './helpers/sto-actor';
import { buildStoFixture } from './helpers/sto-fixture';
import { closeDb, createTenant, destroyTenant, type TestTenant } from './helpers';

const ACTOR = 'ITEM22_STO_TEST';
const DAY = '2026-10-15';
let tenant: TestTenant;
let client = '';
let all: Awaited<ReturnType<typeof makeStoActor>>;
let key = 0;
const nextKey = () => `sto-${++key}`;

const issueInput = (orderNumber: string, items: Array<{ itemNumber: number; quantity: number | string; storageLocation?: string; batch?: string }>, extra: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, orderNumber, postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
  items: items.map((i) => ({ storageLocation: '0001', ...i })), ...extra,
});
const receiptInput = (orderNumber: string, lines: Array<{ itemNumber: number; quantity: number | string; storageLocation?: string; batch?: string }>, extra: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, orderNumber, postingDate: DAY, documentDate: DAY, requestKey: nextKey(),
  lines: lines.map((l) => ({ storageLocation: '0001', ...l })), ...extra,
});
const reverseInput = (materialDocumentNumber: string, extra: Record<string, unknown> = {}) => ({
  client, changedBy: ACTOR, materialDocumentNumber, postingDate: DAY, documentDate: DAY, requestKey: nextKey(), ...extra,
});

const header = (over: Record<string, unknown> = {}) => ({
  documentType: 'STOCK_TRANSPORT', supplyingPlant: '1000', purchasingOrg: '1000', purchasingGroup: '001',
  companyCode: '1000', ...over,
});
const stoItem = (over: Record<string, unknown> = {}) => ({
  materialNumber: 'MAT-A', quantity: 100, unit: 'PC', plant: '1100', storageLocation: '',
  scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 100 }], ...over,
});

async function create(headerOver: Record<string, unknown> = {}, itemOver: Record<string, unknown> = {}) {
  const result = await createOrder({ client, changedBy: ACTOR, ...header(headerOver), items: [stoItem(itemOver)] } as never);
  return result.orderNumber;
}

async function stock(mat: string, plant: string, location: string, type: string): Promise<number> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select quantity from stock_quantity where client = ${client} and material_number = ${mat} and plant = ${plant}
        and storage_location = ${location} and stock_type = ${type}
    `) as unknown as Array<{ quantity: string }>;
    return rows[0] ? Number(rows[0].quantity) : 0;
  });
}
async function valuation(mat: string, plant: string): Promise<{ quantity: number; value: number }> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select total_stock_quantity, stock_value from material_valuation
       where client = ${client} and material_number = ${mat} and valuation_area = ${plant}
    `) as unknown as Array<{ total_stock_quantity: string; stock_value: string }>;
    return { quantity: Number(rows[0].total_stock_quantity), value: Number(rows[0].stock_value) };
  });
}
async function counts() {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select (select count(*) from material_document where client = ${client})::int as docs,
             (select count(*) from journal_entry where client = ${client})::int as journals,
             (select count(*) from sto_transit_allocation where client = ${client})::int as allocs
    `) as unknown as Array<{ docs: number; journals: number; allocs: number }>;
    return rows[0];
  });
}
async function journalLines(journalNumber: string) {
  return withTenant(client, async (tx) => tx.execute(sql`
    select company_code, gl_account, debit_credit, amount_document::text as doc, amount_local::text as local,
           currency, trading_partner_company
      from journal_entry_line where client = ${client} and document_number = ${journalNumber} order by line_number
  `)) as unknown as Promise<Array<{ company_code: string; gl_account: string; debit_credit: string; doc: string; local: string; currency: string; trading_partner_company: string | null }>>;
}
const balanced = (lines: Array<{ debit_credit: string; doc: string; local: string }>) => {
  const sum = (dc: string, f: 'doc' | 'local') => lines.filter((l) => l.debit_credit === dc).reduce((s, l) => s + Number(l[f]), 0);
  return Math.abs(sum('S', 'doc') - sum('H', 'doc')) < 1e-9 && Math.abs(sum('S', 'local') - sum('H', 'local')) < 1e-9;
};

beforeAll(async () => {
  tenant = await createTenant('item22-sto');
  client = tenant.client;
  await buildStoFixture(client, ACTOR);
  all = await makeStoActor(client, 'all', { plants: ['1000', '1100', '2000', '3000'] });
}, 240_000);

afterAll(async () => {
  if (client) await destroyTenant(client);
  await closeDb();
}, 240_000);

const issue = (input: ReturnType<typeof issueInput>, actor = all) => postStoIssue(input, { authorization: actor });
const receive = (input: ReturnType<typeof receiptInput>, actor = all) => postStoReceipt(input, { authorization: actor });
const reverse = (input: ReturnType<typeof reverseInput>, actor = all) => reverseStoDocument(input, { authorization: actor });

describe('ITEM-22 STO create and change', () => {
  it('creates an order with no supplier, from the receiving company, drawn from the PO number range', async () => {
    const number = await create();
    expect(number).toMatch(/^POF-\d{7}$/);
    const doc = await getOrder(client, number);
    expect(doc).toMatchObject({ documentType: 'STOCK_TRANSPORT', supplierNumber: '', supplyingPlant: '1000', companyCode: '1000' });
    expect(doc?.items[0]).toMatchObject({ itemNumber: 10, plant: '1100', quantity: '100.000', netValue: '0.0000' });
    const status = await getStoStatus(client, number);
    expect(status).toMatchObject({ supplyingPlant: '1000', crossCompany: false });
    expect(status?.items[0]).toMatchObject({ orderedBase: '100.000', netIssued: '0.000', inTransit: '0.000', issueable: '100.000' });
  });

  it('refuses unsupported fields by name instead of ignoring them', async () => {
    await expect(createOrder({ client, changedBy: ACTOR, ...header(), supplierNumber: 'V1', items: [stoItem()] } as never))
      .rejects.toThrow(/does not take: supplierNumber \(it has no supplier/);
    await expect(createOrder({ client, changedBy: ACTOR, ...header(), items: [stoItem({ netPrice: 5, contractNumber: 'C1' })] } as never))
      .rejects.toThrow(/netPrice .*contractNumber/s);
  });

  it('judges plants, company, extension and schedule at the service boundary', async () => {
    await expect(create({}, { plant: '1000' })).rejects.toThrow(/also the supplying plant/);
    await expect(create({}, { plant: '2000' })).rejects.toThrow(/belongs to company code 2000, not the order's company code 1000/);
    await expect(create({ supplyingPlant: '9999' })).rejects.toThrow(/supplying plant 9999 does not exist/);
    await expect(create({}, { materialNumber: 'NOPE' })).rejects.toThrow(/Material NOPE does not exist/);
    await expect(create({}, { scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 60 }] })).rejects.toThrow(/schedule lines total 60.000, not the item quantity 100.000/);
    await expect(create({}, { quantity: '1.0005' })).rejects.toThrow(/at most three decimals/);
  });

  it('never converts an order between types and refuses a supplying plant on a supplier order', async () => {
    const number = await create();
    await expect(changeOrder({
      client, changedBy: ACTOR, orderNumber: number, documentType: 'STANDARD', supplierNumber: 'V1',
      purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', items: [],
    } as never)).rejects.toThrow(/cannot be changed into a supplier order/);
    await expect(createOrder({
      client, changedBy: ACTOR, documentType: 'STANDARD', supplierNumber: 'V1', supplyingPlant: '1000',
      purchasingOrg: '1000', purchasingGroup: '001', companyCode: '1000', items: [],
    } as never)).rejects.toThrow(/supplier order carries no supplying plant/);
  });
});

describe('ITEM-22 same-company STO: two partial issues and two receipts', () => {
  let order = '';
  let issue1 = '';
  let issue2 = '';

  it('issues 40 into transit of the receiving plant, not into its unrestricted stock', async () => {
    order = await create();
    const before = await stock('MAT-A', '1000', '0001', 'UNRESTRICTED');
    const doc = await issue(issueInput(order, [{ itemNumber: 10, quantity: 40 }]));
    issue1 = doc.materialDocumentNumber;
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]).toMatchObject({ movementType: 'STO_GI', lineDirection: 'ISSUE', plant: '1000', stockType: 'UNRESTRICTED', quantity: '40.000', value: '400.0000' });
    expect(doc.lines[1]).toMatchObject({ lineDirection: 'RECEIPT', plant: '1100', storageLocation: '', stockType: 'IN_TRANSIT', value: '400.0000' });
    expect(doc.lines[1].issueDocument).toBe(issue1);
    expect(await stock('MAT-A', '1000', '0001', 'UNRESTRICTED')).toBe(before - 40);
    expect(await stock('MAT-A', '1100', '', 'IN_TRANSIT')).toBe(40);
    expect(await stock('MAT-A', '1100', '0001', 'UNRESTRICTED')).toBe(0);
    expect(await valuation('MAT-A', '1000')).toEqual({ quantity: 960, value: 9600 });
    expect(await valuation('MAT-A', '1100')).toEqual({ quantity: 40, value: 400 });
    const status = await getStoStatus(client, order);
    expect(status?.items[0]).toMatchObject({ netIssued: '40.000', netReceived: '0.000', inTransit: '40.000', issueable: '60.000' });
    // Same company, same inventory account: the valuation movement stays auditable on the lines and the ledger, no zero journal.
    expect(doc.journals).toHaveLength(0);
  });

  it('issues a second partial quantity and keeps every figure reconciled', async () => {
    const doc = await issue(issueInput(order, [{ itemNumber: 10, quantity: 30 }]));
    issue2 = doc.materialDocumentNumber;
    expect(await stock('MAT-A', '1100', '', 'IN_TRANSIT')).toBe(70);
    const status = await getStoStatus(client, order);
    expect(status?.items[0]).toMatchObject({ netIssued: '70.000', inTransit: '70.000', issueable: '30.000' });
    expect(status?.items[0].allocations).toHaveLength(2);
    expect((await reconcileStoItem(client, order, 10)).reconciled).toBe(true);
  });

  it('refuses an over-issue, naming ordered, issued and issueable', async () => {
    const error = await issue(issueInput(order, [{ itemNumber: 10, quantity: 31 }])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockTransportError);
    expect((error as StockTransportError).message).toMatch(/ordered 100.000 PC, already issued 70.000, issueable 30.000; 31.000 was asked/);
  });

  it('receives 50 from transit across both issues (FIFO), carrying each issue\'s own value', async () => {
    const doc = await receive(receiptInput(order, [{ itemNumber: 10, quantity: 50 }]));
    const receiptLines = doc.lines.filter((l) => l.lineDirection === 'RECEIPT');
    expect(receiptLines.map((l) => [l.issueDocument, l.quantity])).toEqual([[issue1, '40.000'], [issue2, '10.000']]);
    expect(doc.lines.filter((l) => l.lineDirection === 'ISSUE').every((l) => l.stockType === 'IN_TRANSIT')).toBe(true);
    expect(await stock('MAT-A', '1100', '', 'IN_TRANSIT')).toBe(20);
    expect(await stock('MAT-A', '1100', '0001', 'UNRESTRICTED')).toBe(50);
    // A receipt is not a purchase: no GR/IR, no journal, value stays in the receiving valuation area.
    expect(doc.journals).toHaveLength(0);
    expect(await valuation('MAT-A', '1100')).toEqual({ quantity: 70, value: 700 });
    const status = await getStoStatus(client, order);
    expect(status?.items[0]).toMatchObject({ netIssued: '70.000', netReceived: '50.000', inTransit: '20.000' });
  });

  it('refuses a receipt beyond what stands in transit, and a receipt of an order that is not an STO', async () => {
    await expect(receive(receiptInput(order, [{ itemNumber: 10, quantity: 21 }])))
      .rejects.toThrow(/20.000 PC stands in transit, 21.000 was asked/);
    await expect(receive(receiptInput('NOPE', [{ itemNumber: 10, quantity: 1 }]))).rejects.toThrow(/do not exist/);
  });

  it('receives the rest; only then is everything on hand and nothing in transit', async () => {
    await receive(receiptInput(order, [{ itemNumber: 10, quantity: 20 }]));
    expect(await stock('MAT-A', '1100', '', 'IN_TRANSIT')).toBe(0);
    expect(await stock('MAT-A', '1100', '0001', 'UNRESTRICTED')).toBe(70);
    const status = await getStoStatus(client, order);
    expect(status?.items[0]).toMatchObject({ netIssued: '70.000', netReceived: '70.000', inTransit: '0.000', issueable: '30.000' });
    expect((await reconcileStoItem(client, order, 10)).reconciled).toBe(true);
    await expect(receive(receiptInput(order, [{ itemNumber: 10, quantity: 1 }]))).rejects.toThrow(/Nothing is in transit/);
  });

  it('replays the same request key, and refuses the same key with a different quantity', async () => {
    const o = await create();
    const input = issueInput(o, [{ itemNumber: 10, quantity: 5 }]);
    const first = await issue(input);
    const again = await issue(input);
    expect(again.materialDocumentNumber).toBe(first.materialDocumentNumber);
    expect(await stock('MAT-A', '1100', '', 'IN_TRANSIT')).toBe(5);
    await expect(issue({ ...input, items: [{ itemNumber: 10, quantity: 6, storageLocation: '0001' }] }))
      .rejects.toThrow(/different posting: the stored request does not match/);
  });

  it('refuses to edit the order below what is issued, and freezes the moved item', async () => {
    await expect(changeOrder({
      client, changedBy: ACTOR, orderNumber: order, ...header(), items: [stoItem({ itemNumber: 10, quantity: 60, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 60 }] })],
    } as never)).rejects.toThrow(/cannot fall below the 70.000 already issued/);
    await expect(changeOrder({
      client, changedBy: ACTOR, orderNumber: order, ...header(), items: [stoItem({ itemNumber: 10, materialNumber: 'MAT-X' })],
    } as never)).rejects.toThrow(/material cannot change/);
    await expect(changeOrder({
      client, changedBy: ACTOR, orderNumber: order, ...header(), items: [stoItem({ itemNumber: 10, markedForDeletion: true })],
    } as never)).rejects.toThrow(/cannot be flagged for deletion/);
  });
});

async function clearingAccount(company: string): Promise<string> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select intercompany_clearing_account as a from company_code where client = ${client} and company_code = ${company}`) as unknown as Array<{ a: string }>;
    return rows[0].a;
  });
}
async function journalStatus(number: string): Promise<string> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`select status from journal_entry where client = ${client} and document_number = ${number}`) as unknown as Array<{ status: string }>;
    return rows[0]?.status ?? '';
  });
}

describe('ITEM-22 cross-company STO: two balanced journals, reversal in both companies', () => {
  let order = '';
  let issueDoc = '';
  let sendingJournal = '';
  let receivingJournal = '';

  it('posts one balanced journal per company, each on its own plant inventory account, stamped with the partner', async () => {
    order = await create({ companyCode: '2000' }, { plant: '2000' });
    const status = await getStoStatus(client, order);
    expect(status).toMatchObject({ supplyingCompany: '1000', companyCode: '2000', crossCompany: true });
    const clearing1000 = await clearingAccount('1000');
    const clearing2000 = await clearingAccount('2000');
    const doc = await issue(issueInput(order, [{ itemNumber: 10, quantity: 40 }]));
    issueDoc = doc.materialDocumentNumber;
    expect(doc.journals.map((j) => [j.role, j.companyCode]).sort()).toEqual([['RECEIVING', '2000'], ['SENDING', '1000']]);
    expect(doc.journalDocumentNumber).toBe(doc.journals.find((j) => j.role === 'SENDING')!.journalDocumentNumber);
    sendingJournal = doc.journals.find((j) => j.role === 'SENDING')!.journalDocumentNumber;
    receivingJournal = doc.journals.find((j) => j.role === 'RECEIVING')!.journalDocumentNumber;
    expect(sendingJournal).not.toBe(receivingJournal);

    const send = await journalLines(sendingJournal);
    const recv = await journalLines(receivingJournal);
    expect(balanced(send)).toBe(true);
    expect(balanced(recv)).toBe(true);
    // Sending company: clearing debited (it is owed the value), its own plant's inventory credited.
    expect(send.map((l) => [l.company_code, l.gl_account, l.debit_credit, l.doc])).toEqual([
      ['1000', clearing1000, 'S', '400.0000'], ['1000', '120000', 'H', '400.0000'],
    ]);
    // Receiving company: ITS plant's inventory account (a different one) against its own clearing.
    expect(recv.map((l) => [l.company_code, l.gl_account, l.debit_credit, l.doc])).toEqual([
      ['2000', '121000', 'S', '400.0000'], ['2000', clearing2000, 'H', '400.0000'],
    ]);
    expect(send.every((l) => l.trading_partner_company === '2000')).toBe(true);
    expect(recv.every((l) => l.trading_partner_company === '1000')).toBe(true);
    // Clearing balances agree in transaction currency.
    const sendClearing = send.find((l) => l.gl_account === clearing1000)!;
    const recvClearing = recv.find((l) => l.gl_account === clearing2000)!;
    expect(sendClearing.doc).toBe(recvClearing.doc);
    expect(sendClearing.debit_credit).not.toBe(recvClearing.debit_credit);
    expect(await stock('MAT-A', '2000', '', 'IN_TRANSIT')).toBe(40);
    expect(await valuation('MAT-A', '2000')).toEqual({ quantity: 40, value: 400 });
  });

  it('101 moves transit to on-hand without GR/IR, a supplier or a journal', async () => {
    const before = await counts();
    const doc = await receive(receiptInput(order, [{ itemNumber: 10, quantity: 10 }]));
    expect(doc.journals).toHaveLength(0);
    expect((await counts()).journals).toBe(before.journals);
    expect(await stock('MAT-A', '2000', '', 'IN_TRANSIT')).toBe(30);
    expect(await stock('MAT-A', '2000', '0001', 'UNRESTRICTED')).toBe(10);
    const grir = await withTenant(client, async (tx) => tx.execute(sql`
      select count(*)::int as n from material_document_line where client = ${client} and purchase_order_number = ${order}
    `)) as unknown as Array<{ n: number }>;
    expect(grir[0].n).toBe(0);
  });

  it('refuses 352 while a quantity of it has been received, and names the 102 to post first', async () => {
    await expect(reverse(reverseInput(issueDoc))).rejects.toThrow(/10.000 of line 1 has already been received/);
  });

  it('102 restores the exact transit, then 352 restores the source and reverses BOTH journals once', async () => {
    const receiptDoc = (await getStoStatus(client, order))!.history.find((h) => h.code === '101')!.materialDocumentNumber;
    const rev102 = await reverse(reverseInput(receiptDoc));
    expect(rev102.lines.map((l) => l.movementType)).toEqual(['STO_GR_REV', 'STO_GR_REV']);
    expect(await stock('MAT-A', '2000', '', 'IN_TRANSIT')).toBe(40);
    expect(await stock('MAT-A', '2000', '0001', 'UNRESTRICTED')).toBe(0);
    await expect(reverse(reverseInput(receiptDoc))).rejects.toThrow(/already been reversed/);

    const rev352 = await reverse(reverseInput(issueDoc));
    expect(rev352.reversalOf).toBe(issueDoc);
    expect(rev352.journals.map((j) => j.role).sort()).toEqual(['RECEIVING', 'SENDING']);
    expect(await journalStatus(sendingJournal)).toBe('REVERSED');
    expect(await journalStatus(receivingJournal)).toBe('REVERSED');
    const reversalLines = await journalLines(rev352.journals.find((j) => j.role === 'RECEIVING')!.journalDocumentNumber);
    expect(reversalLines.every((l) => l.trading_partner_company === '1000')).toBe(true);
    expect(await stock('MAT-A', '2000', '', 'IN_TRANSIT')).toBe(0);
    expect(await valuation('MAT-A', '2000')).toEqual({ quantity: 0, value: 0 });
    await expect(reverse(reverseInput(issueDoc))).rejects.toThrow(/already been reversed/);
    const status = await getStoStatus(client, order);
    expect(status?.items[0]).toMatchObject({ netIssued: '0.000', netReceived: '0.000', inTransit: '0.000', issueable: '100.000' });
    expect((await reconcileStoItem(client, order, 10)).reconciled).toBe(true);
  });

  it('refuses before writing when an inventory account is missing for the receiving company', async () => {
    const o = await create({ companyCode: '2000' }, { plant: '2000' });
    await withTenant(client, (tx) => tx.execute(sql`delete from gl_account_company where client = ${client} and company_code = '2000' and gl_account = '121000'`));
    const before = await counts();
    try {
      await expect(issue(issueInput(o, [{ itemNumber: 10, quantity: 10 }]))).rejects.toThrow(/account 121000 is not extended to company 2000/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`
        insert into gl_account_company (client, company_code, chart_of_accounts, gl_account, account_currency, created_by)
        select client, '2000', chart_of_accounts, '121000', currency, ${ACTOR} from company_code where client = ${client} and company_code = '2000'
        on conflict do nothing`));
    }
    expect(await counts()).toEqual(before);
  });

  it('a failure of the SECOND journal (receiving company) rolls back the first journal, the stock, the ledger and the number', async () => {
    const o = await create({ companyCode: '2000' }, { plant: '2000' });
    // Company 2000's journal number range is exhausted: the sending journal posts, the receiving one cannot.
    await withTenant(client, (tx) => tx.execute(sql`
      update number_range set current_number = to_number, changed_at = now()
       where client = ${client} and object_code = 'RF_BELEG' and company_code = '2000'`));
    const before = await counts();
    const stockBefore = await stock('MAT-A', '1000', '0001', 'UNRESTRICTED');
    const valuationBefore = await valuation('MAT-A', '1000');
    try {
      await expect(issue(issueInput(o, [{ itemNumber: 10, quantity: 10 }]))).rejects.toThrow();
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`
        update number_range set current_number = 100 where client = ${client} and object_code = 'RF_BELEG' and company_code = '2000'`));
    }
    expect(await counts()).toEqual(before);
    expect(await stock('MAT-A', '1000', '0001', 'UNRESTRICTED')).toBe(stockBefore);
    expect(await valuation('MAT-A', '1000')).toEqual(valuationBefore);
    expect(await stock('MAT-A', '2000', '', 'IN_TRANSIT')).toBe(0);
    // The order is untouched and issues normally once the range is available again.
    expect((await getStoStatus(client, o))?.items[0].netIssued).toBe('0.000');
  });

  it('refuses when a company has no clearing account, and writes nothing', async () => {
    const o = await create({ companyCode: '2000' }, { plant: '2000' });
    await withTenant(client, (tx) => tx.execute(sql`update company_code set intercompany_clearing_account = null where client = ${client} and company_code = '2000'`));
    const before = await counts();
    try {
      await expect(issue(issueInput(o, [{ itemNumber: 10, quantity: 10 }]))).rejects.toThrow(/carries no OBYA intercompany clearing account/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`update company_code set intercompany_clearing_account = ${'110100'} where client = ${client} and company_code = '2000'`));
    }
    expect(await counts()).toEqual(before);
  });

  it('refuses when the receiving company\'s material period is closed, and writes nothing', async () => {
    const o = await create({ companyCode: '2000' }, { plant: '2000' });
    await withTenant(client, (tx) => tx.execute(sql`update material_period_control set current_period = 12, previous_period = 11, allow_backposting = false where client = ${client} and company_code = '2000'`));
    const before = await counts();
    try {
      await expect(issue(issueInput(o, [{ itemNumber: 10, quantity: 10 }]))).rejects.toThrow(/closed for company 2000/);
    } finally {
      await withTenant(client, (tx) => tx.execute(sql`update material_period_control set current_period = 10, previous_period = 9, allow_backposting = true where client = ${client} and company_code = '2000'`));
    }
    expect(await counts()).toEqual(before);
  });
});

describe('ITEM-22 price differences at the receipt (standard-priced receiving plant)', () => {
  it('same company: books the difference at 101 to the price-difference account and takes it back at 102', async () => {
    const o = await create({}, { materialNumber: 'MAT-S', quantity: 20, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 20 }] });
    await issue(issueInput(o, [{ itemNumber: 10, quantity: 20 }]));
    // At issue the receiving valuation carries the source value; the standard price has not acted yet.
    expect(await valuation('MAT-S', '1100')).toEqual({ quantity: 20, value: 200 });
    const rec = await receive(receiptInput(o, [{ itemNumber: 10, quantity: 20 }]));
    const pd = rec.journals.find((j) => j.role === 'PRICE_DIFFERENCE')!;
    const lines = await journalLines(pd.journalDocumentNumber);
    expect(lines.map((l) => [l.gl_account, l.debit_credit, l.doc])).toEqual([['120000', 'S', '40.0000'], ['300000', 'H', '40.0000']]);
    expect(balanced(lines)).toBe(true);
    expect(await valuation('MAT-S', '1100')).toEqual({ quantity: 20, value: 240 });
    const rev = await reverse(reverseInput(rec.materialDocumentNumber));
    expect(rev.journals.map((j) => j.role)).toEqual(['PRICE_DIFFERENCE']);
    expect(await journalStatus(pd.journalDocumentNumber)).toBe('REVERSED');
    expect(await valuation('MAT-S', '1100')).toEqual({ quantity: 20, value: 200 });
    expect(await stock('MAT-S', '1100', '', 'IN_TRANSIT')).toBe(20);
  });

  it('cross company: a receiver standard below the issue value posts a loss, sign and amount exact', async () => {
    const o = await create({ companyCode: '2000' }, { materialNumber: 'MAT-S', plant: '2000', quantity: 10, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 10 }] });
    await issue(issueInput(o, [{ itemNumber: 10, quantity: 10 }]));
    const rec = await receive(receiptInput(o, [{ itemNumber: 10, quantity: 10 }]));
    const pd = rec.journals.find((j) => j.role === 'PRICE_DIFFERENCE')!;
    expect(pd.companyCode).toBe('2000');
    const lines = await journalLines(pd.journalDocumentNumber);
    expect(lines.map((l) => [l.company_code, l.gl_account, l.debit_credit, l.doc])).toEqual([['2000', '121000', 'H', '10.0000'], ['2000', '300000', 'S', '10.0000']]);
    expect(await valuation('MAT-S', '2000')).toEqual({ quantity: 10, value: 90 });
  });
});

describe('ITEM-22 different company currencies', () => {
  it('uses the newest rate on or before the posting date, never a later one, and keeps journal and valuation in agreement', async () => {
    const o = await create({ companyCode: '3000' }, { plant: '3000' });
    const doc = await issue(issueInput(o, [{ itemNumber: 10, quantity: 40 }]));
    const recv = doc.journals.find((j) => j.role === 'RECEIVING')!;
    const lines = await journalLines(recv.journalDocumentNumber);
    expect(lines.map((l) => [l.currency, l.doc, l.local])).toEqual([['USD', '400.0000', '360.0000'], ['USD', '400.0000', '360.0000']]);
    expect(balanced(lines)).toBe(true);
    const header = await withTenant(client, async (tx) => tx.execute(sql`
      select exchange_rate::text as r, local_currency from journal_entry where client = ${client} and document_number = ${recv.journalDocumentNumber}
    `)) as unknown as Array<{ r: string; local_currency: string }>;
    expect(Number(header[0].r)).toBeCloseTo(0.9, 8);
    expect(header[0].local_currency).toBe('EUR');
    expect(await valuation('MAT-A', '3000')).toEqual({ quantity: 40, value: 360 });
    const alloc = await withTenant(client, async (tx) => tx.execute(sql`
      select source_currency, issue_value::text as iv, receiving_currency, transit_value::text as tv, exchange_rate::text as r
        from sto_transit_allocation where client = ${client} and order_number = ${o}
    `)) as unknown as Array<Record<string, string>>;
    expect(alloc[0]).toMatchObject({ source_currency: 'USD', iv: '400.0000', receiving_currency: 'EUR', tv: '360.0000' });
    expect(Number(alloc[0].r)).toBeCloseTo(0.9, 8);
    // A later rate change does not rewrite the issue; reversal returns the historical value.
    await withTenant(client, (tx) => tx.execute(sql`update exchange_rate set rate = 0.1 where client = ${client} and valid_from = '2026-01-01' and from_currency = 'USD' and to_currency = 'EUR'`));
    await reverse(reverseInput(doc.materialDocumentNumber));
    expect(await valuation('MAT-A', '3000')).toEqual({ quantity: 0, value: 0 });
    await withTenant(client, (tx) => tx.execute(sql`update exchange_rate set rate = 0.9 where client = ${client} and valid_from = '2026-01-01' and from_currency = 'USD' and to_currency = 'EUR'`));
  });

  it('refuses atomically when no rate stands on or before the posting date', async () => {
    const o = await create({ companyCode: '3000' }, { plant: '3000' });
    const before = await counts();
    const error = await issue(issueInput(o, [{ itemNumber: 10, quantity: 5 }], { postingDate: '2025-12-31', documentDate: '2025-12-31' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockTransportError);
    expect((error as Error).message).toMatch(/No AVERAGE exchange rate stands from USD to EUR on or before 2025-12-31|closed for company/);
    expect(await counts()).toEqual(before);
  });
});

describe('ITEM-22 concurrency and authorization', () => {
  it('two competing issues cannot exceed the order: exactly one wins and transit never over-counts', async () => {
    const o = await create({}, { quantity: 100, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 100 }] });
    const results = await Promise.allSettled([
      issue(issueInput(o, [{ itemNumber: 10, quantity: 60 }])),
      issue(issueInput(o, [{ itemNumber: 10, quantity: 60 }])),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const status = await getStoStatus(client, o);
    expect(status?.items[0]).toMatchObject({ netIssued: '60.000', inTransit: '60.000', issueable: '40.000' });
  });

  it('the same request key submitted twice at once posts one document', async () => {
    const o = await create({}, { quantity: 50, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 50 }] });
    const input = issueInput(o, [{ itemNumber: 10, quantity: 10 }]);
    const [a, b] = await Promise.all([issue(input), issue(input)]);
    expect(a.materialDocumentNumber).toBe(b.materialDocumentNumber);
    expect((await getStoStatus(client, o))?.items[0].netIssued).toBe('10.000');
  });

  it('competing receipts cannot take more than stands in transit', async () => {
    const o = await create({}, { quantity: 50, scheduleLines: [{ deliveryDate: '2026-11-15', quantity: 50 }] });
    await issue(issueInput(o, [{ itemNumber: 10, quantity: 30 }]));
    const results = await Promise.allSettled([
      receive(receiptInput(o, [{ itemNumber: 10, quantity: 20 }])),
      receive(receiptInput(o, [{ itemNumber: 10, quantity: 20 }])),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const status = await getStoStatus(client, o);
    expect(status?.items[0]).toMatchObject({ netReceived: '20.000', inTransit: '10.000' });
  });

  it('judges the actor against BOTH plants: capability alone does not reach another company', async () => {
    const same = await create();
    const cross = await create({ companyCode: '2000' }, { plant: '2000' });
    const onlyReceiving = await makeStoActor(client, 'recvonly', { plants: ['1100', '2000'] });
    await expect(issue(issueInput(same, [{ itemNumber: 10, quantity: 1 }]), onlyReceiving)).rejects.toThrow(/Company Code or Plant scope does not cover plant 1000/);
    const company1000 = await makeStoActor(client, 'co1000', { plants: ['1000', '1100'] });
    await expect(issue(issueInput(cross, [{ itemNumber: 10, quantity: 1 }]), company1000)).rejects.toThrow(/does not cover plant 2000/);
    const noCapability = await makeStoActor(client, 'nocap', { capabilities: ['INV.GR.POST'], plants: ['1000', '1100'] });
    await expect(issue(issueInput(same, [{ itemNumber: 10, quantity: 1 }]), noCapability)).rejects.toThrow(/INV.TRANSFER.POST|authority|capabil/i);
    await expect(postStoIssue(issueInput(same, [{ itemNumber: 10, quantity: 1 }]))).rejects.toThrow(/signed-in user/);
    // The receiving side alone may receive, but cannot undo an issue that wrote the other company's books.
    const issued = await issue(issueInput(cross, [{ itemNumber: 10, quantity: 5 }]));
    await expect(reverse(reverseInput(issued.materialDocumentNumber), onlyReceiving.userId === '' ? all : await makeStoActor(client, 'recvrev', { plants: ['2000'] })))
      .rejects.toThrow(/does not cover plant 1000/);
  });
});
