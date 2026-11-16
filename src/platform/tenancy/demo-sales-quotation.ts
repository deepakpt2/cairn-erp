/**
 * Demo phase D18_SALES_QUOTATION — the quotation, reachable.
 *
 * Three quotations that show what a quotation is, each request-keyed so the phase can be re-run:
 * - an open one for CUS-2000 with three items, then changed (an item's quantity up, one item rejected) and
 *   raised to a sales order — the order names the quotation and is priced and credit-checked on its own day;
 * - a rejected one for CUS-3000, with a reason, which cannot be copied;
 * - an expired one for CUS-1000, given five weeks ago and valid to four weeks ago, still OPEN in the table
 *   (expiry is read from the date and never written), which cannot be copied either.
 * Quantities are small and the customers have credit headroom, so the one order that is raised changes the
 * demo's availability and receivables as little as an order can. Nothing else is changed.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../db/client';
import {
  changeQuotation, createOrderFromQuotation, createQuotation, getQuotation, rejectQuotation, type QuotationView,
} from '../../modules/sales/quotation';
import { DEMO_STRUCTURE } from './demo-organisation';
import { withActingUser } from './demo-people';
import type { DemoTimeline } from './demo-provisioning';

const SALES_CLERK = 'demo.sales';
const KEYS = {
  open: 'DEMO-VA21-OPEN-1', rejected: 'DEMO-VA21-REJECTED-1', expired: 'DEMO-VA21-EXPIRED-1', order: 'DEMO-VA21-ORDER-1',
} as const;

export interface DemoSalesQuotationResult {
  open: { quotationNumber: string; version: number; netValue: string; grossValue: string; orderNumber: string; items: string[] };
  rejected: { quotationNumber: string; reason: string | null };
  expired: { quotationNumber: string; validTo: string; status: string; isExpired: boolean };
}

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export async function buildDemoSalesQuotation(input: { client: string; timeline: DemoTimeline }): Promise<DemoSalesQuotationResult> {
  const client = input.client;
  const anchor = input.timeline.anchorDate;
  const org = {
    salesOrg: DEMO_STRUCTURE.salesOrg, distributionChannel: DEMO_STRUCTURE.distributionChannel,
    division: DEMO_STRUCTURE.division, companyCode: DEMO_STRUCTURE.companyCode, currency: 'KWD',
  };
  const item = (materialNumber: string, plant: string, orderQuantity: number, quantityUnit: string, lineNumber?: number) => ({
    lineNumber, materialNumber, plant, orderQuantity, quantityUnit, taxCode: 'S5',
  });

  // The expired quotation is dated into the past, but never before the price records it is priced from.
  const [earliest] = (await withTenant(client, (tx) => tx.execute(sql`
    select max(validity_from)::text as d from (
      select min(validity_from) as validity_from from sales_condition_record
       where client = ${client} and material_number = 'FG-CHOC' group by customer_number) m`))) as unknown as Array<{ d: string | null }>;
  const pastDate = [addDays(anchor, -35), earliest?.d ?? '0000-01-01'].sort().at(-1)!;

  return withActingUser(client, SALES_CLERK, async (actor) => {
    // 1. The open quotation.
    const open = await createQuotation({
      client, changedBy: SALES_CLERK, ...org, customerNumber: 'CUS-2000', quotationDate: anchor,
      validTo: addDays(anchor, 7), requestedDate: addDays(anchor, 10), headerText: 'Demo quotation', requestKey: KEYS.open,
      lines: [
        item('FG-CHOC', '1000', 200, 'PC'), item('FG-CREAM', '1000', 100, 'PC'), item('TRAD-JUICE', '2000', 20, 'BOX'),
      ],
    }, { authorization: actor });
    let current: QuotationView = open;
    if (current.version === 1) {
      // Quantity up on item 10, item 20 rejected with a reason; item 30 stands.
      current = await changeQuotation({
        client, changedBy: SALES_CLERK, ...org, customerNumber: 'CUS-2000', quotationNumber: open.quotationNumber,
        expectedVersion: current.version, quotationDate: open.quotationDate, validTo: open.validTo,
        requestedDate: open.requestedDate ?? undefined, headerText: 'Demo quotation',
        lines: [item('FG-CHOC', '1000', 300, 'PC', 10), item('TRAD-JUICE', '2000', 20, 'BOX', 30)],
        rejectLines: [{ lineNumber: 20, reason: 'STCK' }],
      });
    }
    const raised = await createOrderFromQuotation({
      client, changedBy: SALES_CLERK, quotationNumber: open.quotationNumber, expectedVersion: current.version,
      orderDate: anchor, requestKey: KEYS.order,
    }, { authorization: actor });

    // 2. The rejected quotation.
    const second = await createQuotation({
      client, changedBy: SALES_CLERK, ...org, customerNumber: 'CUS-3000', quotationDate: anchor,
      validTo: addDays(anchor, 14), headerText: 'Demo quotation, lost on price', requestKey: KEYS.rejected,
      lines: [item('FG-WAFER', '1000', 400, 'PC')],
    }, { authorization: actor });
    const rejected = second.status === 'OPEN'
      ? await rejectQuotation({ client, changedBy: SALES_CLERK, quotationNumber: second.quotationNumber, expectedVersion: second.version, reason: 'PRCE' })
      : second;

    // 3. The expired quotation: given in the past, valid to a date that has passed, status still OPEN.
    const third = await createQuotation({
      client, changedBy: SALES_CLERK, ...org, customerNumber: 'CUS-1000', quotationDate: pastDate,
      validTo: addDays(pastDate, 7), headerText: 'Demo quotation that was not answered', requestKey: KEYS.expired,
      lines: [item('FG-CREAM', '1000', 150, 'PC')],
    }, { authorization: actor });
    const expired = (await getQuotation(client, third.quotationNumber, anchor))!;

    const finalOpen = (await getQuotation(client, open.quotationNumber, anchor))!;
    return {
      open: {
        quotationNumber: finalOpen.quotationNumber, version: finalOpen.version, netValue: finalOpen.netValue,
        grossValue: finalOpen.grossValue, orderNumber: raised.orderNumber,
        items: finalOpen.lines.map((l) => `${l.lineNumber} ${l.materialNumber} ${Number(l.quotationQuantity)} ${l.quantityUnit.trim()} ${l.status}${l.rejectionReason ? `(${l.rejectionReason})` : ''} confirmed ${l.confirmedQuantity ?? '—'}`),
      },
      rejected: { quotationNumber: rejected.quotationNumber, reason: rejected.rejectionReason },
      expired: { quotationNumber: expired.quotationNumber, validTo: expired.validTo, status: expired.status, isExpired: expired.isExpired },
    };
  });
}
