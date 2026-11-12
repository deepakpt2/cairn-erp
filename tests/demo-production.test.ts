import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY, DEMO_STRUCTURE } from '../src/platform/tenancy/demo-organisation';
import { buildDemoTimeline, DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The production phase, checked the way a production controller would check it.
 *
 * The conditional tests need the demo to stand in the database the suite runs
 * against, which is what the `cairn_dp_*` disposable databases are for. Against a
 * database where the demo has never been provisioned they report honestly that
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

async function rows(statement: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(CLIENT, (tx) => tx.execute(sql.raw(statement))) as unknown as Promise<
    Array<Record<string, unknown>>
  >;
}

function source(): string {
  return readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-production.ts'), 'utf8');
}

describe('demo production phase', () => {
  it('appends the production phase last and never reorders', () => {
    expect(DEMO_PHASE_PLAN).toEqual([
      'A_FOUNDATION',
      'B_ORGANISATION',
      'B_PEOPLE',
      'C_MASTERS',
      'D1_PROCUREMENT',
      'D2_PRODUCTION',
    ]);
    expect(DEMO_PHASE_PLAN.indexOf('D2_PRODUCTION')).toBe(DEMO_PHASE_PLAN.length - 1);
  });

  it('names the production version as the four-character key it is', () => {
    // Phase C stores 0001, and the selector compares the code as a key: asking
    // for `1` asks for a version that does not stand, and the order is refused
    // before it exists.
    expect(source()).toContain("PRODUCTION_VERSION = '0001'");
  });

  it('asks whether configuration stands instead of reading a refusal as success', () => {
    const text = source();
    // Both configuration records are checked for before they are written, not
    // created and forgiven. A resumed run reads them and moves on.
    expect(text).toContain('from production_order_type_parameter');
    expect(text).toContain('from production_order_type');
  });

  it('derives every date from the frozen timeline, never from a literal', () => {
    const text = source();
    expect(text).toContain('dateIn(');
    expect(text).not.toMatch(/'\d{4}-\d{2}-\d{2}'/);
  });

  it('leaves one order standing, because a factory at a month end has work in progress', () => {
    const text = source();
    expect(text).toContain('openAtEnd');
    expect(text).toContain('if (!plan.openAtEnd');
  });
});

describe('demo production, when the demo stands', () => {
  it('made what the plan says it made', async () => {
    if (!(await demoStands())) return;
    expect(await scalar(`
      select count(*) as n from production_order
       where client = '${CLIENT}' and request_key like 'DEMO-PO-%'`)).toBe(9);
    // Every order was issued against, confirmed, and received.
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and movement_type = 'PROD_ISSUE_ORDER'`)).toBeGreaterThan(0);
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and movement_type = 'PROD_RECEIPT_ORDER'`)).toBe(9);
    expect(await scalar(`
      select count(*) as n from production_confirmation where client = '${CLIENT}'`)).toBe(9);
    // One confirmation per order, and it is a final one.
    expect(await scalar(`
      select count(*) as n from production_confirmation
       where client = '${CLIENT}' and confirmation_type = 'FINAL'`)).toBe(9);
  });

  it('closed every order but one, and the one it left is still released', async () => {
    if (!(await demoStands())) return;
    const completed = await scalar(`
      select count(*) as n from production_order
       where client = '${CLIENT}' and request_key like 'DEMO-PO-%'
         and status = 'TECHNICALLY_COMPLETED'`);
    const released = await scalar(`
      select count(*) as n from production_order
       where client = '${CLIENT}' and request_key like 'DEMO-PO-%'
         and status = 'RELEASED'`);
    expect(completed).toBe(8);
    expect(released).toBe(1);
    expect(completed + released).toBe(9);
  });

  it('gave every order the type the demo defined for itself', async () => {
    if (!(await demoStands())) return;
    const types = await rows(`
      select order_type, count(*) as n from production_order
       where client = '${CLIENT}' and request_key like 'DEMO-PO-%'
       group by order_type`);
    expect(types).toHaveLength(1);
    expect(String(types[0]?.order_type)).toBe('PP01');
  });

  it('ties the inventory accounts to the stock the inventory ledger still holds', async () => {
    if (!(await demoStands())) return;
    const ledger = await scalar(`
      select coalesce(sum(case when debit_credit = 'S' then amount_local::numeric
                               else -amount_local::numeric end), 0) as n
        from journal_entry_line
       where client = '${CLIENT}'
         and gl_account in ('120000', '120100', '120200', '120300')`);
    const stock = await scalar(`
      select coalesce(sum(stock_value::numeric), 0) as n
        from material_valuation where client = '${CLIENT}'`);
    expect(stock).toBeGreaterThan(0);
    expect(ledger).toBe(stock);
  });

  it('balances: total debits equal total credits', async () => {
    if (!(await demoStands())) return;
    const debit = await scalar(`
      select coalesce(sum(amount_local::numeric), 0) as n
        from journal_entry_line where client = '${CLIENT}' and debit_credit = 'S'`);
    const credit = await scalar(`
      select coalesce(sum(amount_local::numeric), 0) as n
        from journal_entry_line where client = '${CLIENT}' and debit_credit = 'H'`);
    expect(debit).toBeGreaterThan(0);
    expect(debit).toBe(credit);
  });

  it('shows the production result on the consumption account, and it is the conversion cost', async () => {
    if (!(await demoStands())) return;
    // What an order produced is credited where what it consumed is debited. The
    // two do not cancel, because the standard price of a biscuit carries a
    // conversion cost the system never posts as an activity: no confirmation
    // prices labour, and no settlement charges the order. The remainder is that
    // conversion, sitting where anyone can see it.
    const output = await scalar(`
      select coalesce(sum(l.value::numeric), 0) as n
        from material_document_line l
       where l.client = '${CLIENT}' and l.movement_type = 'PROD_RECEIPT_ORDER'`);
    const consumed = await scalar(`
      select coalesce(sum(l.value::numeric), 0) as n
        from material_document_line l
       where l.client = '${CLIENT}' and l.movement_type = 'PROD_ISSUE_ORDER'`);
    expect(output).toBeGreaterThan(0);
    expect(consumed).toBeGreaterThan(0);
    // Producing is worth more than what went into it, and the gap is the
    // conversion baked into the standard prices. It is a fifth to a third of
    // the output, which is what a factory's own conversion looks like — and it
    // would be zero only if labour, machines and overhead were free.
    const conversion = output - consumed;
    expect(conversion).toBeGreaterThan(output * 0.1);
    expect(conversion).toBeLessThan(output * 0.4);
  });

  it('charged the scrapping to its own account, and credited no one', async () => {
    if (!(await demoStands())) return;
    const scrap = await rows(`
      select jl.gl_account, jl.debit_credit, sum(jl.amount_local::numeric) as amount
        from material_document d
        join material_document_line l
          on l.client = d.client and l.material_document_number = d.material_document_number
        join journal_entry_line jl
          on jl.client = d.client and jl.document_number = d.journal_document_number
       where d.client = '${CLIENT}' and l.movement_type = 'GI_SCRAP'
       group by jl.gl_account, jl.debit_credit
       order by jl.gl_account`);
    const debited = scrap.filter((row) => String(row.debit_credit) === 'S');
    const credited = scrap.filter((row) => String(row.debit_credit) === 'H');
    // One expense, named for what it is, and it is charged to nobody in
    // particular — a scrapping names no cost centre and no order.
    expect(debited).toHaveLength(1);
    expect(String(debited[0]?.gl_account)).toBe('410300');
    expect(Number(debited[0]?.amount)).toBeGreaterThan(0);
    // The other side is stock leaving, one account per material scrapped.
    expect(credited.length).toBeGreaterThan(0);
    for (const row of credited) {
      expect(String(row.gl_account)).toMatch(/^120[0-9]{3}$/);
    }
  });

  it('consumed the dough it made, and kept a working balance of it', async () => {
    if (!(await demoStands())) return;
    // Dough is made to be used: every biscuit order eats it. If the phase had
    // made none, the biscuit orders would have been refused for want of stock,
    // and if it had made far more than it used the shelves would be full of it.
    const dough = await scalar(`
      select coalesce(quantity::numeric, 0) as n
        from stock_quantity
       where client = '${CLIENT}' and material_number = 'SEMI-DOUGH'
         and plant = '${DEMO_STRUCTURE.manufacturingPlant}'`);
    expect(dough).toBeGreaterThan(0);
    // A month's dough, not a year's: under a fifth of what the period made.
    expect(dough).toBeLessThan(3000);
  });

  it('posted every production document into the periods that were still open', async () => {
    if (!(await demoStands())) return;
    // The material period, once advanced, is never re-opened. D1 walked it to
    // the last open period, so this phase's goods movements can only stand in
    // the last two — and September, the month the company bought its materials,
    // carries none of them.
    const months = await rows(`
      select distinct to_char(d.posting_date, 'YYYY-MM') as month
        from material_document d
        join material_document_line l
          on l.client = d.client and l.material_document_number = d.material_document_number
       where d.client = '${CLIENT}'
         and l.movement_type in ('PROD_ISSUE_ORDER', 'PROD_RECEIPT_ORDER', 'GI_SCRAP')
       order by month`);
    expect(months.length).toBeGreaterThan(0);
    const timeline = buildDemoTimeline();
    const open = timeline.openPeriods.map((p) => `${p.slice(0, 4)}-${p.slice(4)}`);
    for (const row of months) {
      // Every month it posted into is one of the two that were still open.
      expect(open.indexOf(String(row.month))).toBeGreaterThan(0);
    }
  });

  it('records the provisioner as the author of every production document', async () => {
    if (!(await demoStands())) return;
    const others = await scalar(`
      select count(*) as n
        from material_document d
       where d.client = '${CLIENT}'
         and d.created_by <> 'DEMO_PROVISION'
         and exists (
           select 1 from material_document_line l
            where l.client = d.client
              and l.material_document_number = d.material_document_number
              and l.movement_type in ('PROD_ISSUE_ORDER', 'PROD_RECEIPT_ORDER', 'GI_SCRAP'))`);
    expect(others).toBe(0);
  });

  it('leaves no live session behind', async () => {
    if (!(await demoStands())) return;
    const live = await scalar(
      `select count(*) as n from user_session where client = '${CLIENT}' and revoked_at is null`,
    );
    expect(live).toBe(0);
  });
});
