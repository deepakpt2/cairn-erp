/**
 * Internal order line items (KOB1): src/modules/foundation/internal-order-cost-report.ts.
 *
 * Fixtures write balanced journal documents directly (as tests/internal-order.test.ts does), so a
 * status, a reversal link or an origin can be set exactly. Every document balances: the order line
 * is offset by a clearing line that carries no order.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';
import { controllingArea, controllingAreaCompany, documentType, internalOrder } from '../src/modules/foundation/schema';
import { journalEntry, journalEntryLine } from '../src/modules/finance/schema';
import {
  getInternalOrderCostReport,
  holdsInternalOrderCostReportAuthority,
  INTERNAL_ORDER_COST_REPORT_CAPABILITY,
  InternalOrderCostReportError,
  type InternalOrderCostReportInput,
} from '../src/modules/foundation/internal-order-cost-report';
import { closeDb, createTenant, destroyTenant } from './helpers';

const ACTOR = 'KOB1_TEST';
const HELD = [INTERNAL_ORDER_COST_REPORT_CAPABILITY];
const EXPENSE = '400000';
const TRAVEL = '410000';
const CLEARING = '199000';

let client = '';
let company = '';
let area = '';
let currency = '';
let docType = '';

interface Doc {
  number: string;
  postingDate: string;
  period: number;
  year?: number;
  status?: 'POSTED' | 'PARKED' | 'REVERSED';
  reversalOf?: string;
  reversedBy?: string;
  originClass?: string;
  localCurrency?: string;
  /** Lines on the order; each is offset by one clearing line on the other side. */
  lines: Array<{ order: string; side: 'S' | 'H'; amount: string; gl?: string; text?: string }>;
}

async function post(doc: Doc) {
  const year = doc.year ?? 2026;
  const local = doc.localCurrency ?? currency;
  await withTenant(client, async (tx) => {
    await tx.insert(journalEntry).values({
      client,
      documentNumber: doc.number,
      displayNumber: `JE-${doc.number}`,
      fiscalYear: year,
      documentType: docType,
      companyCode: company,
      documentDate: doc.postingDate,
      postingDate: doc.postingDate,
      postingPeriod: doc.period,
      documentCurrency: local,
      localCurrency: local,
      status: doc.status ?? 'POSTED',
      reversalOf: doc.reversalOf ?? null,
      reversedBy: doc.reversedBy ?? null,
      originClass: doc.originClass ?? null,
      originKey: doc.originClass ? `${doc.number}-origin` : null,
      createdBy: ACTOR,
    });
    let lineNumber = 0;
    for (const line of doc.lines) {
      lineNumber += 1;
      await tx.insert(journalEntryLine).values({
        client, documentNumber: doc.number, fiscalYear: year, lineNumber,
        glAccount: line.gl ?? EXPENSE, companyCode: company, debitCredit: line.side,
        amountLocal: line.amount, amountDocument: line.amount, currency: local,
        internalOrder: line.order, lineText: line.text ?? null,
      });
      lineNumber += 1;
      await tx.insert(journalEntryLine).values({
        client, documentNumber: doc.number, fiscalYear: year, lineNumber,
        glAccount: CLEARING, companyCode: company, debitCredit: line.side === 'S' ? 'H' : 'S',
        amountLocal: line.amount, amountDocument: line.amount, currency: local,
      });
    }
  });
}

async function order(orderNumber: string, flags: { statistical?: boolean; markedForDeletion?: boolean } = {}) {
  await withTenant(client, async (tx) => {
    await tx.insert(internalOrder).values({
      client, orderNumber, orderType: 'IO01', description: `Order ${orderNumber}`,
      controllingArea: area, companyCode: company, currency,
      startDate: '2026-01-01', endDate: '2027-12-31',
      costCenter: 'CC100', profitCenter: null,
      statistical: flags.statistical ?? false,
      markedForDeletion: flags.markedForDeletion ?? false,
      createdBy: ACTOR,
    });
  });
}

function report(orderNumber: string, extra: Partial<InternalOrderCostReportInput> = {}) {
  return getInternalOrderCostReport({ client, heldCapabilities: HELD, orderNumber, ...extra });
}

beforeAll(async () => {
  const tenant = await createTenant('kob1-report');
  client = tenant.client;
  await withTenant(client, async (tx) => {
    const [assignment] = await tx.select().from(controllingAreaCompany).where(eq(controllingAreaCompany.client, client));
    const [ca] = await tx.select().from(controllingArea).where(eq(controllingArea.client, client));
    const [type] = await tx.select().from(documentType).where(eq(documentType.client, client)).limit(1);
    company = assignment.companyCode;
    area = assignment.controllingArea;
    currency = ca.currency.trim();
    docType = type.documentType;
  });

  // IO-MAIN: the main order. Documents are inserted out of posting-date order on purpose.
  await order('IO-MAIN');
  await post({ number: 'D-0300', postingDate: '2026-03-15', period: 3, lines: [{ order: 'IO-MAIN', side: 'S', amount: '300.0000', text: 'March' }] });
  await post({ number: 'D-0100', postingDate: '2026-01-10', period: 1, lines: [
    { order: 'IO-MAIN', side: 'S', amount: '100.0000', text: 'Jan a' },
    { order: 'IO-MAIN', side: 'S', amount: '50.0000', gl: TRAVEL, text: 'Jan b' },
  ] });
  await post({ number: 'D-0200', postingDate: '2026-02-20', period: 2, lines: [{ order: 'IO-MAIN', side: 'H', amount: '20.0000', text: 'Credit back' }] });
  await post({ number: 'D-0400', postingDate: '2026-04-05', period: 4, lines: [{ order: 'IO-MAIN', side: 'S', amount: '40.0000', gl: TRAVEL }] });
  await post({ number: 'D-PARK', postingDate: '2026-02-01', period: 2, status: 'PARKED', lines: [{ order: 'IO-MAIN', side: 'S', amount: '999.0000' }] });
  await post({ number: 'D-OTHER', postingDate: '2026-02-01', period: 2, lines: [{ order: 'IO-ELSE', side: 'S', amount: '777.0000' }] });
  // A reversed document (period 5) and its reversal (period 6).
  await post({ number: 'D-0500', postingDate: '2026-05-02', period: 5, status: 'REVERSED', reversedBy: 'D-0501', lines: [{ order: 'IO-MAIN', side: 'S', amount: '60.0000' }] });
  await post({ number: 'D-0501', postingDate: '2026-06-01', period: 6, reversalOf: 'D-0500', lines: [{ order: 'IO-MAIN', side: 'H', amount: '60.0000' }] });
  // A settlement credit, as /controlling/order-settlement posts it (origin class order_settlement).
  await post({ number: 'D-SETTLE', postingDate: '2026-06-30', period: 6, originClass: 'order_settlement', lines: [{ order: 'IO-MAIN', side: 'H', amount: '470.0000', text: 'Settlement' }] });
  // A 2025 document, outside the 2026 filter.
  await post({ number: 'D-2025', year: 2025, postingDate: '2025-12-15', period: 12, lines: [{ order: 'IO-MAIN', side: 'S', amount: '10.0000' }] });

  // IO-MIXED: lines in the order currency and in another local currency.
  await order('IO-MIXED');
  await post({ number: 'M-1', postingDate: '2026-01-05', period: 1, lines: [{ order: 'IO-MIXED', side: 'S', amount: '100.0000' }] });
  await post({ number: 'M-2', postingDate: '2026-01-06', period: 1, localCurrency: 'EUR', lines: [
    { order: 'IO-MIXED', side: 'S', amount: '70.0000' },
    { order: 'IO-MIXED', side: 'H', amount: '5.0000' },
  ] });

  await order('IO-EMPTY');
  await order('IO-STAT', { statistical: true });
  await post({ number: 'S-1', postingDate: '2026-01-07', period: 1, lines: [{ order: 'IO-STAT', side: 'S', amount: '12.0000' }] });
  await order('IO-DEL', { markedForDeletion: true });
  await post({ number: 'X-1', postingDate: '2026-01-08', period: 1, lines: [{ order: 'IO-DEL', side: 'S', amount: '13.0000' }] });
});

afterAll(async () => {
  if (client) await destroyTenant(client);
  await closeDb();
});

const keys = (r: Awaited<ReturnType<typeof report>>) => r.lines.map((l) => `${l.documentNumber}/${l.lineNumber}`);

describe('internal order line items (KOB1)', () => {
  it('1. returns the posted lines that carry the order, and only those', async () => {
    const r = await report('IO-MAIN');
    expect(r.lines.every((l) => ['POSTED', 'REVERSED'].includes(l.status))).toBe(true);
    expect(keys(r)).toContain('D-0300/1');
    expect(keys(r)).not.toContain('D-OTHER/1');
    // Clearing lines carry no order and are not listed.
    expect(r.lines.some((l) => l.glAccount === CLEARING)).toBe(false);
    // Eight 2026 lines and one 2025 line; the parked line and IO-ELSE's line are not here.
    expect(r.lines).toHaveLength(9);
  });

  it('2. excludes parked documents', async () => {
    const r = await report('IO-MAIN');
    expect(r.lines.some((l) => l.documentNumber === 'D-PARK')).toBe(false);
    expect(r.lines.some((l) => l.amountLocal === '999.0000')).toBe(false);
  });

  it('3. shows a reversed document and its reversal, each with its link', async () => {
    const r = await report('IO-MAIN');
    const reversed = r.lines.find((l) => l.documentNumber === 'D-0500')!;
    const reversal = r.lines.find((l) => l.documentNumber === 'D-0501')!;
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversedBy).toBe('D-0501');
    expect(reversal.status).toBe('POSTED');
    expect(reversal.reversalOf).toBe('D-0500');
    // Both halves are listed, so no reversal-pair gap.
    expect(r.gaps.some((g) => /reversal pair/.test(g))).toBe(false);
    // Filtering one half away is reported, not hidden.
    const half = await report('IO-MAIN', { fiscalYear: 2026, periodFrom: 5, periodTo: 5 });
    expect(keys(half)).toEqual(['D-0500/1']);
    expect(half.gaps.find((g) => /reversal pair/.test(g))).toContain('D-0500 (reversed by D-0501)');
  });

  it('4. orders lines by posting date, then document, then line number', async () => {
    const r = await report('IO-MAIN', { fiscalYear: 2026 });
    expect(keys(r)).toEqual(['D-0100/1', 'D-0100/3', 'D-0200/1', 'D-0300/1', 'D-0400/1', 'D-0500/1', 'D-0501/1', 'D-SETTLE/1']);
    const dates = r.lines.map((l) => l.postingDate);
    expect([...dates].sort()).toEqual(dates);
  });

  it('5. applies fiscal-year and period filters inclusively at both ends', async () => {
    const r = await report('IO-MAIN', { fiscalYear: '2026', periodFrom: '2', periodTo: '4' });
    expect(new Set(r.lines.map((l) => l.postingPeriod))).toEqual(new Set([2, 3, 4]));
    expect(keys(r)).toEqual(['D-0200/1', 'D-0300/1', 'D-0400/1']);
    expect(r.filter).toEqual({ fiscalYear: 2026, periodFrom: 2, periodTo: 4, glAccount: null });
    const y2025 = await report('IO-MAIN', { fiscalYear: 2025 });
    expect(keys(y2025)).toEqual(['D-2025/1']);
    await expect(report('IO-MAIN', { periodFrom: 2 })).rejects.toThrow(/fiscal year/i);
  });

  it('6. applies the G/L account (cost element) filter', async () => {
    const r = await report('IO-MAIN', { glAccount: TRAVEL });
    expect(keys(r)).toEqual(['D-0100/3', 'D-0400/1']);
    expect(r.filter.glAccount).toBe(TRAVEL);
    expect(r.totals[0].debitLocal).toBe('90.0000');
  });

  it('7. groups totals by (company, document currency, local currency) with correct debit, credit and net', async () => {
    const r = await report('IO-MAIN', { fiscalYear: 2026 });
    expect(r.totals).toEqual([{
      companyCode: company, documentCurrency: currency, localCurrency: currency,
      // Debits: 300 + 100 + 50 + 40 + 60 = 550. Credits: 20 + 60 + 470 = 550.
      debitDocument: '550.0000', creditDocument: '550.0000', netDocument: '0.0000',
      debitLocal: '550.0000', creditLocal: '550.0000', netLocal: '0.0000',
    }]);
    expect(r.netInOrderCurrency).toBe('0.0000');
  });

  it("8. counts 'S' as debit and 'H' as credit", async () => {
    const debit = await report('IO-MAIN', { fiscalYear: 2026, periodFrom: 3, periodTo: 3 });
    expect(debit.lines[0].debitCredit).toBe('S');
    expect(debit.totals[0]).toMatchObject({ debitLocal: '300.0000', creditLocal: '0.0000', netLocal: '300.0000' });
    expect(debit.netInOrderCurrency).toBe('300.0000');
    const credit = await report('IO-MAIN', { fiscalYear: 2026, periodFrom: 2, periodTo: 2 });
    expect(credit.lines[0].debitCredit).toBe('H');
    // The stored amount is positive; the sign comes from 'H' alone.
    expect(credit.lines[0].amountLocal).toBe('20.0000');
    expect(credit.totals[0]).toMatchObject({ debitLocal: '0.0000', creditLocal: '20.0000', netLocal: '-20.0000' });
    expect(credit.netInOrderCurrency).toBe('-20.0000');
  });

  it('9. refuses an order that does not stand, naming it, with the maintenance route as remedy', async () => {
    const attempt = report('IO-NOPE');
    await expect(attempt).rejects.toBeInstanceOf(InternalOrderCostReportError);
    await expect(attempt).rejects.toThrow(/IO-NOPE/);
    const caught = await report('IO-NOPE').catch((e: InternalOrderCostReportError) => e);
    expect((caught as InternalOrderCostReportError).remedy).toContain('/controlling/internal-orders');
    await expect(report('IO-MAIN', { fiscalYear: 2026, periodFrom: 5, periodTo: 2 })).rejects.toThrow(/5.*2/);
    await expect(report('IO-MAIN', { fiscalYear: 2026, periodFrom: 17 })).rejects.toThrow(/17/);
    await expect(report('IO-MAIN', { fiscalYear: 2026, periodTo: 0 })).rejects.toThrow(/0/);
    await expect(report('IO-MAIN', { fiscalYear: 'twenty' })).rejects.toThrow(/twenty/);
    await expect(report('IO-MAIN', { fiscalYear: 99 })).rejects.toThrow(/99/);
  });

  it('10. returns an empty report, not an error, for an order with no lines', async () => {
    const r = await report('IO-EMPTY');
    expect(r.lines).toEqual([]);
    expect(r.totals).toEqual([]);
    expect(r.netInOrderCurrency).toBe('0.0000');
    expect(r.gaps.some((g) => /No posted or reversed journal lines/.test(g))).toBe(true);
  });

  it('11. with mixed currencies: totals complete per group, no net in order currency, gap names the currencies', async () => {
    const r = await report('IO-MIXED');
    expect(r.totals).toHaveLength(2);
    const home = r.totals.find((t) => t.localCurrency === currency)!;
    const eur = r.totals.find((t) => t.localCurrency === 'EUR')!;
    expect(home).toMatchObject({ debitLocal: '100.0000', creditLocal: '0.0000', netLocal: '100.0000' });
    expect(eur).toMatchObject({ debitLocal: '70.0000', creditLocal: '5.0000', netLocal: '65.0000' });
    expect(r.netInOrderCurrency).toBeNull();
    const gap = r.gaps.find((g) => /No net in order currency/.test(g));
    expect(gap).toBeDefined();
    expect(gap).toContain('EUR');
    expect(gap).toContain(currency);
  });

  it('12. reports a statistical order with the marker set', async () => {
    const r = await report('IO-STAT');
    expect(r.order.statistical).toBe(true);
    expect(r.order.markedForDeletion).toBe(false);
    expect(r.lines).toHaveLength(1);
  });

  it('13. reports an order marked for deletion with the marker set', async () => {
    const r = await report('IO-DEL');
    expect(r.order.markedForDeletion).toBe(true);
    expect(r.lines).toHaveLength(1);
    expect(r.order).toMatchObject({ orderNumber: 'IO-DEL', orderType: 'IO01', companyCode: company, controllingArea: area, currency, costCenter: 'CC100', profitCenter: null });
  });

  it('14. gives each line what /finance/journal/document needs to open it', async () => {
    const r = await report('IO-MAIN');
    for (const line of r.lines) {
      expect(line.documentNumber).toBeTruthy();
      expect(line.companyCode).toBe(company);
      expect(Number.isInteger(line.fiscalYear)).toBe(true);
      expect(line.displayNumber).toBe(`JE-${line.documentNumber}`);
    }
  });

  it('15. refuses an actor without the capability in the service, before reading anything', async () => {
    for (const held of [[], ['CO.ORDER.DISPLAY'], ['CO.*'], ['*']]) {
      expect(holdsInternalOrderCostReportAuthority(held)).toBe(false);
      // The same refusal for a real order and a missing one: nothing is learnt about what exists.
      await expect(getInternalOrderCostReport({ client, heldCapabilities: held, orderNumber: 'IO-MAIN' }))
        .rejects.toThrow(`You do not hold ${INTERNAL_ORDER_COST_REPORT_CAPABILITY}.`);
      await expect(getInternalOrderCostReport({ client, heldCapabilities: held, orderNumber: 'IO-NOPE' }))
        .rejects.toThrow(`You do not hold ${INTERNAL_ORDER_COST_REPORT_CAPABILITY}.`);
    }
    expect(holdsInternalOrderCostReportAuthority(['CO.ORDER.COST.DISPLAY'])).toBe(true);
  });

  it('16. shows lines posted by settlement as ordinary lines', async () => {
    const r = await report('IO-MAIN');
    const settle = r.lines.find((l) => l.documentNumber === 'D-SETTLE')!;
    expect(settle).toMatchObject({ status: 'POSTED', originClass: 'order_settlement', debitCredit: 'H', amountLocal: '470.0000', lineText: 'Settlement' });
  });

  it('writes nothing', async () => {
    const count = () => withTenant(client, async (tx) => (await tx.select().from(journalEntryLine).where(eq(journalEntryLine.client, client))).length);
    const before = await count();
    await report('IO-MAIN');
    await report('IO-MIXED');
    expect(await count()).toBe(before);
  });
});
