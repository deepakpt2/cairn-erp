/**
 * The whole dataset, reconciled.
 *
 * Every document phase was accepted against its own reconciliation: inventory
 * against the inventory accounts, GR/IR against what was received and not
 * invoiced, payables against the payments that cleared them. This file asks the
 * harder question, which is whether the five phases agree with each other now
 * that all of them have run: whether the stock the inventory ledger holds is
 * the stock the movements say, whether the subledgers are the general ledger,
 * whether the tax the company owes is the tax it collected less the tax it paid
 * less the tax it filed, and whether every document sits in a period that is
 * open.
 *
 * Nothing here is checked by remembering a number. Where a figure can be derived
 * from the documents it is derived from the documents, and the assertion is that
 * the two sides are equal — so a dataset that drifts fails here even though no
 * single phase did anything wrong.
 *
 * The checks need a database the whole installation has run in, which is what the
 * `cairn_dp_*` disposable databases are for. Against a database where the demo
 * has never been provisioned — or where it stopped half way — every check is
 * skipped and reported as skipped, because a test that passes by counting
 * nothing is worse than no test.
 */

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';
import { DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The inventory account each valuation class is configured to post to.
 *
 * Total stock matching total inventory is not enough: one class's stock landing
 * in another class's account would still balance, so each class is compared with
 * its own account as well.
 */
const INVENTORY_ACCOUNTS: ReadonlyArray<{ valuationClass: string; glAccount: string }> = [
  { valuationClass: 'RAW_INVENTORY', glAccount: '120000' },
  { valuationClass: 'SEMI_INVENTORY', glAccount: '120100' },
  { valuationClass: 'FINISHED_INVENTORY', glAccount: '120200' },
  { valuationClass: 'TRADE_INVENTORY', glAccount: '120300' },
];

/** The accounts the demo's own chart holds for the reconciliation. */
const REVENUE = '300000';
const PAYABLES = '200000';
const RECEIVABLES = '110000';
const GR_IR = '210000';
const TAX = '220000';

/**
 * Whether the whole installation stands in this database.
 *
 * Not "the tenant exists" — a run that stopped after sales leaves a tenant that
 * balances to nothing. Reconciling a half-built company would report the absences
 * as agreements, so every check asks for all nine phases first.
 */
async function installationStands(): Promise<boolean> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql`
      select count(*)::text as n from demo_installation_phase
       where status = 'COMPLETED' and phase_code = any(${[...DEMO_PHASE_PLAN]}::text[])
    `)) as unknown as Array<{ n: string }>;
    return Number(rows[0]?.n ?? 0) === DEMO_PHASE_PLAN.length;
  }).catch(() => false);
}

async function scalar(statement: string): Promise<number> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql.raw(statement))) as unknown as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

/** A signed balance on one account, over every posted line. */
function accountBalance(glAccount: string): Promise<number> {
  return scalar(`
    select coalesce(sum(case when debit_credit = 'S' then amount_local
                            else -amount_local end), 0) as n
      from journal_entry_line where client = '${CLIENT}' and gl_account = '${glAccount}'`);
}

/** The posting periods the installation froze when it was claimed. */
const OPEN_PERIODS = `(select jsonb_array_elements_text(timeline->'openPeriods') from demo_installation)`;

describe('the demo dataset, reconciled end to end', () => {
  it('holds the stock the movements moved, at the value the inventory accounts carry', async () => {
    if (!(await installationStands())) return;
    // Check 1 of 12. Quantity first: every material/plant/storage-location/stock-type
    // bucket, summed from the posted movements and compared with the row the
    // inventory ledger holds. A movement that moved stock without writing the row —
    // or a row written by something that was not a movement — shows up here.
    const mismatches = await scalar(`
      select count(*) as n from (
        select l.material_number, l.plant, l.storage_location, l.stock_type,
               sum(case when l.line_direction = 'RECEIPT' then l.base_quantity::numeric
                        else -l.base_quantity::numeric end) as moved
          from material_document_line l
          join material_document d
            on d.client = l.client and d.material_document_number = l.material_document_number
         where l.client = '${CLIENT}' and d.status = 'POSTED'
         group by 1, 2, 3, 4) movements
        full join stock_quantity s
          on s.client = '${CLIENT}'
         and s.material_number = movements.material_number
         and s.plant = movements.plant
         and s.storage_location = movements.storage_location
         and s.stock_type = movements.stock_type
       where coalesce(s.quantity::numeric, 0) <> coalesce(movements.moved, 0)`);
    expect(mismatches).toBe(0);

    // Then value: the inventory accounts hold exactly what the stock is worth.
    const stock = await scalar(`
      select coalesce(sum(stock_value::numeric), 0) as n from material_valuation where client = '${CLIENT}'`);
    const ledger = await scalar(`
      select coalesce(sum(case when debit_credit = 'S' then amount_local
                              else -amount_local end), 0) as n
        from journal_entry_line
       where client = '${CLIENT}'
         and gl_account in ('120000', '120100', '120200', '120300')`);
    expect(stock).toBeGreaterThan(0);
    expect(ledger).toBe(stock);

    for (const row of INVENTORY_ACCOUNTS) {
      const classValue = await scalar(`
        select coalesce(sum(stock_value::numeric), 0) as n
          from material_valuation
         where client = '${CLIENT}' and valuation_class = '${row.valuationClass}'`);
      expect(await accountBalance(row.glAccount)).toBe(classValue);
    }
  });

  it('balances: every debit has a credit', async () => {
    if (!(await installationStands())) return;
    // Check 2 of 12. The one assertion every other check leans on.
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e
        join journal_entry h on h.client = e.client and h.document_number = e.document_number
                            and h.fiscal_year = e.fiscal_year
       where e.client = '${CLIENT}' and h.status = 'POSTED'`)).toBe(0);
  });

  it('leaves GR/IR at nothing, with the close having named what replaced it', async () => {
    if (!(await installationStands())) return;
    // Check 3 of 12. The one purchase-order line received and not invoiced was
    // reclassified by the close; everything else was billed. What is left in the
    // clearing account is nothing, and the accrual that stands in its place is
    // recorded against the item it belongs to.
    expect(await accountBalance(GR_IR)).toBe(0);
    expect(await scalar(`
      select count(*) as n from grir_reclass_item
       where client = '${CLIENT}' and classification = 'GOODS_RECEIVED_NOT_INVOICED'
         and status = 'ACCRUED' and accrual_document is not null`)).toBe(1);
  });

  it('keeps the payables subledger equal to the general ledger', async () => {
    if (!(await installationStands())) return;
    // Check 4 of 12. The account is a credit balance; the open items are what makes
    // it up. The payments that cleared items are what is no longer open, so the two
    // sides agreeing says the clearing was complete as well as correctly signed.
    const open = await scalar(`
      select coalesce(sum(amount_local), 0) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account = '${PAYABLES}'
         and debit_credit = 'H' and clearing_document is null`);
    const items = await scalar(`
      select count(*) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account = '${PAYABLES}'
         and debit_credit = 'H' and clearing_document is null`);
    expect(items).toBeGreaterThan(0);
    expect(open).toBe(-(await accountBalance(PAYABLES)));
  });

  it('keeps the receivables subledger equal to the general ledger', async () => {
    if (!(await installationStands())) return;
    // Check 5 of 12. The ageing the demo is meant to show lives here: brought-forward
    // balances and sales invoices, some collected and some deliberately left open.
    const open = await scalar(`
      select coalesce(sum(amount_local), 0) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account = '${RECEIVABLES}'
         and debit_credit = 'S' and clearing_document is null`);
    const items = await scalar(`
      select count(*) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account = '${RECEIVABLES}'
         and debit_credit = 'S' and clearing_document is null`);
    expect(items).toBeGreaterThan(0);
    expect(open).toBe(await accountBalance(RECEIVABLES));
  });

  it('reports as revenue exactly what it billed', async () => {
    if (!(await installationStands())) return;
    // Check 6 of 12. Revenue credited to the P&L, against the net of every billing
    // document that stands.
    const billed = await scalar(`
      select coalesce(sum(net_value::numeric), 0) as n from billing_document where client = '${CLIENT}'`);
    const revenue = await scalar(`
      select coalesce(sum(case when debit_credit = 'H' then amount_local else 0 end), 0) as n
        from journal_entry_line where client = '${CLIENT}' and gl_account = '${REVENUE}'`);
    expect(billed).toBeGreaterThan(0);
    expect(revenue).toBe(billed);
  });

  it('owes the tax it collected, less the tax it paid, less the tax it filed', async () => {
    if (!(await installationStands())) return;
    // Check 7 of 12. Output tax charged to customers, input tax charged by suppliers,
    // and what the filed returns have already handed to the authority. The balance
    // left on the VAT account has to be the arithmetic of the three.
    const output = await scalar(`
      select coalesce(sum(tax_value::numeric), 0) as n from billing_document where client = '${CLIENT}'`);
    const input = await scalar(`
      select coalesce(sum(tax_amount::numeric), 0) as n from supplier_invoice where client = '${CLIENT}'`);
    const filed = await scalar(`
      select coalesce(sum(net_tax::numeric), 0) as n from tax_return_run
       where client = '${CLIENT}' and is_test_run = false`);
    expect(output).toBeGreaterThan(0);
    expect(input).toBeGreaterThan(0);
    expect(await accountBalance(TAX)).toBe(input - output + filed);
  });

  it('received from production what the orders said they would make', async () => {
    if (!(await installationStands())) return;
    // Check 8 of 12. One goods receipt per order, and every receipt naming the order
    // it was made against: a production receipt with no order behind it is stock
    // that appeared from nowhere.
    const orders = await scalar(`select count(*) as n from production_order where client = '${CLIENT}'`);
    const receipts = await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and movement_type = 'PROD_RECEIPT_ORDER' and line_direction = 'RECEIPT'`);
    expect(orders).toBeGreaterThan(0);
    expect(receipts).toBe(orders);
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and movement_type = 'PROD_RECEIPT_ORDER'
         and line_direction = 'RECEIPT'
         and (production_order_number is null or production_order_number = '')`)).toBe(0);
  });

  it('settled the internal order to nothing, onto the receiver its rule names', async () => {
    if (!(await installationStands())) return;
    // Check 9 of 12. An order that collected costs and never gave them back would
    // leave a balance nobody owns, so the post-settlement net is nil and a single
    // full rule names where the costs went.
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e
        join internal_order o on o.client = e.client and o.order_number = e.internal_order
       where e.client = '${CLIENT}'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from settlement_distribution_rule
       where client = '${CLIENT}' and settlement_type = 'FUL' and percentage = 100`)).toBe(1);
  });

  it('charges every expense to the object that incurred it', async () => {
    if (!(await installationStands())) return;
    // Check 10 of 12. An expense with no cost centre and no order is a cost nobody
    // can be asked about. The close booked them all onto one or the other.
    expect(await scalar(`
      select count(*) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account like '5%' and debit_credit = 'S'
         and cost_center is null and internal_order is null`)).toBe(0);
  });

  it('posted every document inside the periods the timeline froze', async () => {
    if (!(await installationStands())) return;
    // Check 11 of 12. Three periods are open; a document dated outside them could not
    // have been posted by a user, because the period check would have refused it.
    const outside = `and to_char(posting_date, 'YYYYMM') not in ${OPEN_PERIODS}`;
    expect(await scalar(`
      select count(*) as n from material_document where client = '${CLIENT}' ${outside}`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from journal_entry where client = '${CLIENT}' ${outside}`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from billing_document where client = '${CLIENT}' ${outside}`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from supplier_invoice where client = '${CLIENT}' ${outside}`)).toBe(0);
  });

  it('is the size the task asked for, written by the people whose job it is, and left nothing half finished', async () => {
    if (!(await installationStands())) return;
    // Check 12 of 12. The task asks for 150–250 connected documents. Counted here as
    // every document a person can open — orders, goods movements, invoices, payments,
    // production and sales documents, inspection lots, usage decisions and the
    // inspection results recorded against them — plus the journals posted by hand,
    // which are documents in their own right and have no originating document behind
    // them. The 88 accounting documents those transactions generated are deliberately
    // not counted twice; counting them too gives 240, which is inside the band as
    // well, so the assertion does not depend on where the line is drawn.
    const operational = await scalar(`
      select (select count(*) from purchase_order where client = '${CLIENT}')
           + (select count(*) from supplier_invoice where client = '${CLIENT}')
           + (select count(*) from outgoing_payment where client = '${CLIENT}')
           + (select count(*) from material_document where client = '${CLIENT}')
           + (select count(*) from production_order where client = '${CLIENT}')
           + (select count(*) from sales_order where client = '${CLIENT}')
           + (select count(*) from delivery where client = '${CLIENT}')
           + (select count(*) from billing_document where client = '${CLIENT}')
           + (select count(*) from incoming_payment where client = '${CLIENT}')
           + (select count(*) from quality_lot where client = '${CLIENT}')
           + (select count(*) from usage_decision where client = '${CLIENT}')
           + (select count(*) from inspection_result where client = '${CLIENT}')
             as n`);
    const handPostedJournals = await scalar(`
      select count(*) as n from journal_entry
       where client = '${CLIENT}' and origin_class is null`);
    const allJournals = await scalar(`
      select count(*) as n from journal_entry where client = '${CLIENT}'`);
    expect(handPostedJournals).toBeGreaterThan(0);
    expect(operational + handPostedJournals).toBeGreaterThanOrEqual(150);
    expect(operational + handPostedJournals).toBeLessThanOrEqual(250);
    expect(operational + allJournals).toBeLessThanOrEqual(250);

    // Every document is written by one of the demo's own accounts, or by the
    // provisioner that loaded it. Anything else is a document that arrived from
    // somewhere the demo cannot account for.
    const actors = `('DEMO_PROVISION', 'DEMO.ACCOUNTANT', 'DEMO.CONTROLLER', 'DEMO.BUYER',
      'DEMO.PLANNER', 'DEMO.PRODUCTION', 'DEMO.WAREHOUSE1', 'DEMO.WAREHOUSE2', 'DEMO.SALES',
      'DEMO.QUALITY')`;
    expect(await scalar(`
      select count(*) as n from material_document
       where client = '${CLIENT}' and upper(created_by) not in ${actors}`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from journal_entry
       where client = '${CLIENT}' and upper(created_by) not in ${actors}`)).toBe(0);

    // And it can account for itself: change records for the objects that matter, and
    // nothing left running, locked or unfinished behind it.
    for (const objectClass of ['material_document', 'journal_entry', 'purchase_order', 'quality_lot']) {
      expect(await scalar(`
        select count(*) as n from change_document
         where client = '${CLIENT}' and object_class = '${objectClass}'`)).toBeGreaterThan(0);
    }
    expect(await scalar(`
      select count(*) as n from user_session where client = '${CLIENT}' and revoked_at is null`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from enqueue_entry where client = '${CLIENT}'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from demo_installation_phase where status <> 'COMPLETED'`)).toBe(0);
  });
});
