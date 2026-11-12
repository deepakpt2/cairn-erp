import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY } from '../src/platform/tenancy/demo-organisation';
import { DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The sales and receivables phase, checked the way a sales clerk and a credit
 * controller would check it.
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

function source(): string {
  return readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-sales.ts'), 'utf8');
}

describe('demo sales phase, as it is written', () => {
  it('takes its place after production and before anything that follows it', () => {
    // The plan is append-only. Sales buys nothing and makes nothing, so it can
    // only stand where what it sells is already on the shelf.
    expect(DEMO_PHASE_PLAN.indexOf('D3_SALES')).toBe(DEMO_PHASE_PLAN.indexOf('D2_PRODUCTION') + 1);
    expect(DEMO_PHASE_PLAN.slice(0, 7)).toEqual([
      'A_FOUNDATION',
      'B_ORGANISATION',
      'B_PEOPLE',
      'C_MASTERS',
      'D1_PROCUREMENT',
      'D2_PRODUCTION',
      'D3_SALES',
    ]);
  });

  it('derives every date from the frozen timeline, never from a literal', () => {
    const text = source();
    expect(text).toContain('dateIn(');
    expect(text).not.toMatch(/'\d{4}-\d{2}-\d{2}'/);
  });

  it('keys every step of every chain, so a resumed run finds its own work', () => {
    const text = source();
    // One key per step: a run that died between the pick and the goods issue is
    // handed back the pick it already wrote rather than a second copy of it.
    for (const step of ['ORDER', 'DELIVERY', 'PICK', 'BILL', 'PAY']) {
      expect(text).toContain(`DEMO-SLS-${'${plan.key}'}-${step}`);
    }
  });

  it('stops each chain where the plan says, rather than walking every order to cash', () => {
    const text = source();
    expect(text).toContain('stopAfter');
    expect(text).toContain("plan.stopAfter === 'ORDER'");
    expect(text).toContain("plan.stopAfter === 'GOODS_ISSUE'");
  });

  it('pays the invoice the chain raised, and not the customer down to zero', () => {
    // The opening balances brought these customers' receivables forward, so
    // every one of them already carries an open item this phase never raised.
    // Settling that too would leave the ageing report with nothing old on it.
    const text = source();
    expect(text).toContain('b.request_key');
    expect(text).toContain('raised.some(');
  });

  it('asks the delivery what stands instead of counting what it wrote', () => {
    // A pick and a goods issue are the delivery's own to know: on a resumed run
    // the request key from the run that died is not the whole answer.
    const text = source();
    expect(text).toContain("header.status === 'GOODS_ISSUED'");
    expect(text).toContain("header.status === 'PICKED' || header.status === 'GOODS_ISSUED'");
  });

  it('ships from the plant that holds the goods, with that plant\'s own clerk', () => {
    const text = source();
    expect(text).toContain('WAREHOUSE_CLERK_FACTORY');
    expect(text).toContain('WAREHOUSE_CLERK_CENTRE');
    expect(text).toContain('plan.plant === DEMO_STRUCTURE.manufacturingPlant');
  });
});

describe('demo sales, when the demo stands', () => {
  it('made the documents the plan says it made', async () => {
    if (!(await demoStands())) return;
    expect(await scalar(`
      select count(*) as n from sales_order
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'`)).toBe(6);
    expect(await scalar(`
      select count(*) as n from delivery
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'`)).toBe(5);
    expect(await scalar(`
      select count(*) as n from billing_document
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'`)).toBe(4);
    expect(await scalar(`
      select count(*) as n from incoming_payment
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'`)).toBe(3);
  });

  it('issued the goods for every delivery it raised, and left one order undelivered', async () => {
    if (!(await demoStands())) return;
    expect(await scalar(`
      select count(*) as n from delivery
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'
         and status = 'GOODS_ISSUED' and material_document_number is not null`)).toBe(5);
    // The backlog: an order a person can still pick up and ship.
    expect(await scalar(`
      select count(*) as n from sales_order o
       where o.client = '${CLIENT}' and o.request_key like 'DEMO-SLS-%'
         and not exists (select 1 from delivery d
                          where d.client = o.client and d.order_number = o.order_number)`)).toBe(1);
  });

  it('let no clerk confirm a pick outside the plant they were granted', async () => {
    if (!(await demoStands())) return;
    // Two-plant isolation comes from the scope the clerk was granted, not from
    // the phase choosing a name: the factory clerk picks at the factory and the
    // centre clerk picks at the centre, and neither can pick at the other.
    expect(await scalar(`
      select count(*) as n from delivery_picking p
        join delivery d on d.client = p.client and d.delivery_number = p.delivery_number
       where p.client = '${CLIENT}' and p.request_key like 'DEMO-SLS-%'
         and ((d.plant = '1000' and upper(p.created_by) <> 'DEMO.WAREHOUSE1')
           or (d.plant = '2000' and upper(p.created_by) <> 'DEMO.WAREHOUSE2'))`)).toBe(0);
    expect(await scalar(`
      select count(distinct d.plant) as n from delivery_picking p
        join delivery d on d.client = p.client and d.delivery_number = p.delivery_number
       where p.client = '${CLIENT}' and p.request_key like 'DEMO-SLS-%'`)).toBe(2);
  });

  it('billed by the sales clerk and banked by the accountant, and not the other way round', async () => {
    if (!(await demoStands())) return;
    expect(await scalar(`
      select count(*) as n from billing_document
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'
         and upper(created_by) <> 'DEMO.SALES'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from incoming_payment
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'
         and upper(created_by) <> 'DEMO.ACCOUNTANT'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from sales_order
       where client = '${CLIENT}' and request_key like 'DEMO-SLS-%'
         and upper(created_by) <> 'DEMO.SALES'`)).toBe(0);
  });

  it('cleared the invoices it was meant to clear and left the rest standing', async () => {
    if (!(await demoStands())) return;
    // An invoice posts a receivable, revenue and output tax. Only the line the
    // customer is named on is a receivable, so only that one is ever cleared.
    // Three chains were paid; theirs are the only receivables that are closed.
    expect(await scalar(`
      select count(*) as n from journal_entry_line e
        join customer_invoice i
          on i.client = e.client and i.journal_document_number = e.document_number
         and i.fiscal_year = e.fiscal_year
        join billing_document b
          on b.client = e.client and b.customer_invoice_number = i.invoice_number
       where e.client = '${CLIENT}' and b.request_key like 'DEMO-SLS-%'
         and e.business_partner = i.customer_number
         and e.clearing_document is not null`)).toBe(3);
    // One invoice was billed and left unpaid: the item the ageing report shows
    // as current.
    expect(await scalar(`
      select count(*) as n from journal_entry_line e
        join customer_invoice i
          on i.client = e.client and i.journal_document_number = e.document_number
         and i.fiscal_year = e.fiscal_year
        join billing_document b
          on b.client = e.client and b.customer_invoice_number = i.invoice_number
       where e.client = '${CLIENT}' and b.request_key like 'DEMO-SLS-%'
         and e.business_partner = i.customer_number
         and e.clearing_document is null`)).toBe(1);
    // What the company started with is still owed to it.
    expect(await scalar(`
      select count(*) as n from journal_entry_line e
       where e.client = '${CLIENT}' and e.business_partner like 'CUS-%'
         and e.clearing_document is null
         and not exists (select 1 from customer_invoice i
                          where i.client = e.client
                            and i.journal_document_number = e.document_number
                            and i.fiscal_year = e.fiscal_year)`)).toBe(3);
  });

  it('left the books balanced', async () => {
    if (!(await demoStands())) return;
    // Debits less credits over every line the tenant holds. A phase that sells
    // goods without costing them, or banks money without clearing an invoice,
    // shows up here first.
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e where e.client = '${CLIENT}'`)).toBe(0);
  });
});
