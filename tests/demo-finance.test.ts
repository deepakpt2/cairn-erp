import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';
import { DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The month-end close, checked the way an accountant and a controller would
 * check it.
 *
 * The conditional tests need the demo to stand in the database the suite runs
 * against, which is what the `cairn_dp_*` disposable databases are for. Against
 * a database where the demo has never been provisioned they report honestly that
 * there is nothing to check — a test that passes because it counted nothing is
 * worse than no test.
 */
async function demoStands(): Promise<boolean> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(
      sql`select 1 as present from client where client = ${CLIENT}`,
    )) as unknown as Array<{ present: number }>;
    return rows.length > 0;
  }).catch(() => false);
}

async function scalar(statement: string): Promise<number> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql.raw(statement))) as unknown as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  });
}

async function text(statement: string): Promise<string> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql.raw(statement))) as unknown as Array<{ v: string }>;
    return rows[0]?.v ?? '';
  });
}

/**
 * Whether the close this file checks has actually run in this database.
 *
 * The tenant can stand with the close still in front of it — a deployment that
 * stopped after sales, or a resumed run that has not reached it yet. Counting a
 * close that never happened would report zeroes as though they were a result,
 * so every check below asks first.
 */
async function closeStands(): Promise<boolean> {
  if (!(await demoStands())) return false;
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(
      sql`select 1 as present from demo_installation_phase where phase_code = 'D4_FINANCE' and status = 'COMPLETED'`,
    )) as unknown as Array<{ present: number }>;
    return rows.length > 0;
  }).catch(() => false);
}
function source(): string {
  return readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-finance.ts'), 'utf8');
}

describe('demo finance phase, as it is written', () => {
  it('takes its place after sales and before anything that follows it', () => {
    // The plan is append-only, and finance is last: a close reads what the
    // other three phases left behind, so it can only stand after them.
    expect(DEMO_PHASE_PLAN.indexOf('D4_FINANCE')).toBe(DEMO_PHASE_PLAN.indexOf('D3_SALES') + 1);
    expect(DEMO_PHASE_PLAN.slice(0, 8)).toEqual([
      'A_FOUNDATION',
      'B_ORGANISATION',
      'B_PEOPLE',
      'C_MASTERS',
      'D1_PROCUREMENT',
      'D2_PRODUCTION',
      'D3_SALES',
      'D4_FINANCE',
    ]);
  });

  it('derives every date from the frozen timeline, never from a literal', () => {
    const body = source();
    expect(body).toContain('dateIn(');
    expect(body).toContain('monthEnd(');
    expect(body).not.toMatch(/'\d{4}-\d{2}-\d{2}'/);
  });

  it('keys every step, so a resumed run finds its own work', () => {
    const body = source();
    // One key per document: a run that died between the tax return and the
    // dunning run is handed back the return it already filed rather than a
    // second copy of it.
    for (const key of ['COSTS', 'PAYROLL', 'ORDER', 'BUDGET', 'SETTLE', 'GRIR', 'TAX']) {
      expect(body).toContain(`-${key}`);
    }
    expect(body).toContain('DEMO-FIN-');
  });

  it('closes the month without closing the period behind it', () => {
    const body = source();
    // The whole point of the phase is a month walked to its end and left open.
    // A demo that shut its own books would be a demo nobody could post into.
    expect(body).toMatch(/left open/i);
    expect(body).not.toContain('closePeriod');
    expect(body).not.toContain('postingPeriodStatus');
    expect(body).not.toContain('fiscal_period_status');
  });

  it('names the two people whose job each document is', () => {
    const body = source();
    expect(body).toContain("const ACCOUNTANT = 'demo.accountant';");
    expect(body).toContain("const CONTROLLER = 'demo.controller';");
    // Each is used inside `withActingUser`, because the service they call is the
    // one that asks who is acting.
    expect(body).toContain('withActingUser(client, ACCOUNTANT,');
    expect(body).toContain('withActingUser(client, CONTROLLER,');
  });

  it('leaves open ends on purpose, and says which ones', () => {
    const body = source();
    // The invariant is not "nothing is outstanding". It is "what is outstanding
    // is what the ageing schedule says is outstanding".
    expect(body).toContain('PAYMENT_PLAN');
    expect(body).toMatch(/left (standing|unreported)/);
  });
});

describe('demo finance, when the demo stands', () => {
  it('made the documents the plan says it made', async () => {
    if (!(await closeStands())) return;
    expect(await scalar(`
      select count(*) as n from journal_posting_request
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'`)).toBe(7);
    expect(await scalar(`
      select count(*) as n from outgoing_payment
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from internal_order
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'`)).toBe(1);
    expect(await scalar(`
      select count(*) as n from settlement_document
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'`)).toBe(1);
    expect(await scalar(`
      select count(*) as n from accrual_document
       where client = '${CLIENT}' and reversal_status = 'PENDING'`)).toBe(1);
    expect(await scalar(`
      select count(*) as n from grir_reclass_run
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'`)).toBe(1);
    expect(await scalar(`
      select count(*) as n from tax_return_run
       where client = '${CLIENT}' and is_test_run = false`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from dunning_notice
       where client = '${CLIENT}'`)).toBe(3);
  });

  it('left the books balanced', async () => {
    if (!(await closeStands())) return;
    // Debits less credits over every posted line the tenant holds. A close that
    // accrues without offsetting, settles one side of an order, or clears tax it
    // never reported shows up here first.
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e
        join journal_entry h on h.client = e.client and h.document_number = e.document_number
                            and h.fiscal_year = e.fiscal_year
       where e.client = '${CLIENT}' and h.status = 'POSTED'`)).toBe(0);
  });

  it('posted every document inside one of the frozen open periods', async () => {
    if (!(await closeStands())) return;
    // Not one document outside the timeline: the close is dated from the
    // calendar it was given, never from the day the run happened to happen.
    expect(await scalar(`
      select count(*) as n from journal_entry h
        join journal_posting_request r
          on r.client = h.client and r.document_number = h.document_number
         and r.fiscal_year = h.fiscal_year
       where h.client = '${CLIENT}' and r.request_key like 'DEMO-FIN-%'
         and to_char(h.posting_date, 'YYYYMM') not in (
           select jsonb_array_elements_text(timeline->'openPeriods') from demo_installation)`)).toBe(0);
  });

  it('is written by the accountant and the controller, and not the other way round', async () => {
    if (!(await closeStands())) return;
    // The accountant posts the journals, files the returns, reclassifies the
    // goods received not invoiced and runs the dunning.
    expect(await scalar(`
      select count(*) as n from journal_entry h
        join journal_posting_request r
          on r.client = h.client and r.document_number = h.document_number
         and r.fiscal_year = h.fiscal_year
       where h.client = '${CLIENT}' and r.request_key like 'DEMO-FIN-%'
         and upper(h.created_by) <> 'DEMO.ACCOUNTANT'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from outgoing_payment
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'
         and upper(created_by) <> 'DEMO.ACCOUNTANT'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from tax_return_run
       where client = '${CLIENT}' and is_test_run = false
         and upper(created_by) <> 'DEMO.ACCOUNTANT'`)).toBe(0);
    // The controller keeps the order and settles it.
    expect(await scalar(`
      select count(*) as n from internal_order
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'
         and upper(created_by) <> 'DEMO.CONTROLLER'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from settlement_document
       where client = '${CLIENT}' and request_key like 'DEMO-FIN-%'
         and upper(created_by) <> 'DEMO.CONTROLLER'`)).toBe(0);
  });

  it('paid the suppliers it was meant to pay and left the rest standing', async () => {
    if (!(await closeStands())) return;
    // This phase settles three open items across two vendors, and the goods and
    // services it bought on credit add one more. What is left standing is the
    // payables ageing, which is the point of an open item.
    expect(await scalar(`
      select coalesce(sum(p.items_cleared), 0) as n from outgoing_payment p
       where p.client = '${CLIENT}' and p.request_key like 'DEMO-FIN-%'`)).toBe(3);
    expect(await scalar(`
      select count(*) as n from journal_entry_line e
       where e.client = '${CLIENT}' and e.gl_account = '200000'
         and e.debit_credit = 'H' and e.clearing_document is null`)).toBe(4);
    // The payable this phase itself raised is still open: the supplier payments
    // run before the order's costs are booked, so an invoice the close posts
    // cannot be the one the close settles.
    expect(await scalar(`
      select count(*) as n from journal_entry_line e
        join journal_posting_request r
          on r.client = e.client and r.document_number = e.document_number
         and r.fiscal_year = e.fiscal_year
       where e.client = '${CLIENT}' and r.request_key like 'DEMO-FIN-%'
         and e.gl_account = '200000' and e.debit_credit = 'H'
         and e.clearing_document is not null`)).toBe(0);
  });

  it('moved what the internal order collected onto the cost centre its rule names', async () => {
    if (!(await closeStands())) return;
    // The order collected the agency fee and the travel; the settlement is what
    // says where they belong. Net on the order is zero, and the receiver carries
    // the whole of it.
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e
        join internal_order o on o.client = e.client and o.order_number = e.internal_order
       where e.client = '${CLIENT}' and o.request_key like 'DEMO-FIN-%'`)).toBe(0);
    expect(await scalar(`
      select coalesce(sum(e.amount_local), 0) as n
        from journal_entry_line e
        join settlement_document s on s.client = e.client and s.document_number = e.document_number
                                  and s.fiscal_year = e.fiscal_year
       where e.client = '${CLIENT}' and s.request_key like 'DEMO-FIN-%'
         and e.cost_center is not null and e.internal_order is null`)).toBe(2090);
    // Nothing was settled without a rule that was stored, not assumed.
    expect(await scalar(`
      select count(*) as n from settlement_distribution_rule
       where client = '${CLIENT}' and settlement_type = 'FUL' and percentage = 100`)).toBe(1);
  });

  it('reclassified the goods received not invoiced, and left the clearing account clear', async () => {
    if (!(await closeStands())) return;
    // The one purchase order line received and not invoiced stands accrued, and
    // the GR/IR clearing account it came from nets to nothing at the close.
    expect(await scalar(`
      select count(*) as n from grir_reclass_item
       where client = '${CLIENT}' and classification = 'GOODS_RECEIVED_NOT_INVOICED'
         and status = 'ACCRUED' and accrual_document is not null`)).toBe(1);
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e
        join journal_entry h on h.client = e.client and h.document_number = e.document_number
                            and h.fiscal_year = e.fiscal_year
       where e.client = '${CLIENT}' and e.gl_account = '210000' and h.status = 'POSTED'`)).toBe(0);
  });

  it('filed the returns for the months that ended, and left the month that has not', async () => {
    if (!(await closeStands())) return;
    // Two returns, each with the transfer that cleared it, and no third: a
    // return for a month that has not ended is not a return.
    expect(await scalar(`
      select count(*) as n from tax_return_run
       where client = '${CLIENT}' and is_test_run = false
         and transfer_document_number is not null`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from tax_return_run
       where client = '${CLIENT}' and is_test_run = false
         and posting_date_to >= (select (timeline->>'endDate')::date from demo_installation)`)).toBe(0);
  });

  it('dunned the balances that stood overdue, and excluded nothing', async () => {
    if (!(await closeStands())) return;
    // An account without a dunning procedure is excluded with its reason rather
    // than dunned by default, so the run saying three notices and no exceptions
    // is the run finding the procedures it was given.
    expect(await scalar(`
      select count(*) as n from dunning_run_account
       where client = '${CLIENT}' and status = 'EXCLUDED'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from dunning_notice
       where client = '${CLIENT}' and dunning_level = 1`)).toBe(3);
    expect(await scalar(`
      select count(*) as n from customer_company_code
       where client = '${CLIENT}' and dunning_procedure is null`)).toBe(0);
  });

  it('left the period open and the accrual pending', async () => {
    if (!(await closeStands())) return;
    // The close stops short of closing: what a person walks into is a period
    // they can still post to, and an accrual whose reversal is still to run.
    expect(await text(`
      select p.status as v from demo_installation_phase p
       where p.phase_code = 'D4_FINANCE'`)).toBe('COMPLETED');
    expect(await scalar(`
      select count(*) as n from accrual_document
       where client = '${CLIENT}' and reversal_status = 'PENDING'
         and reversal_date > (select (timeline->>'endDate')::date from demo_installation)`)).toBe(1);
    expect(await scalar(`
      select count(*) as n from posting_period_rule
       where client = '${CLIENT}' and period_from = 1 and period_to = 12`)).toBeGreaterThan(0);
  });
});
