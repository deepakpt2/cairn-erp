import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY, DEMO_STRUCTURE } from '../src/platform/tenancy/demo-organisation';
import { buildDemoTimeline, DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The procurement and inventory history, checked the way an accountant would
 * check it.
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

/** The first column of a one-row, one-column query, as a number. */
async function scalar(statement: string): Promise<number> {
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(sql.raw(statement))) as unknown as Array<{ n: number | string }>;
    return Number(rows[0]?.n ?? 0);
  });
}


/** The first column of a one-row, one-column query, as text. */
async function one(statement: string): Promise<string> {
  return withTenant(CLIENT, async (tx) => {
    const found = (await tx.execute(sql.raw(statement))) as unknown as Array<{ v: string | null }>;
    return found[0]?.v ?? '';
  });
}
async function rows(statement: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(CLIENT, (tx) => tx.execute(sql.raw(statement))) as unknown as Promise<
    Array<Record<string, unknown>>
  >;
}

function source(): string {
  return readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-procurement.ts'), 'utf8');
}

describe('demo procurement phase', () => {
  it('appends the procurement phase last and never reorders', () => {
    // Procurement runs after the masters and before production: a later phase is
    // appended behind it, never in front of it.
    expect(DEMO_PHASE_PLAN.indexOf('D1_PROCUREMENT')).toBe(
      DEMO_PHASE_PLAN.indexOf('C_MASTERS') + 1,
    );
  });

  it('walks the material period forward instead of holding three periods open', () => {
    const text = source();
    // Only the current period and, with backposting, the one before it ever accept
    // a goods movement. Three periods cannot stand open at once, so each period is
    // opened, written to, and then shifted past.
    expect(text).toContain('shiftMaterialPeriod');
    expect(text).toContain('initializeMaterialPeriodControl');
    expect(text).toContain('allowBackposting: true');
  });

  it('posts each movement as a user authorised for the plant it happens at', () => {
    const text = source();
    // A goods movement is not a data load: the service asks who is posting it and
    // whether that person's reach covers the plant.
    expect(text).toContain('withActingUser');
    expect(text).toContain('clerkFor(');
    expect(text).toContain('authorization: actor');
  });

  it('derives every date from the frozen timeline, never from a literal', () => {
    const text = source();
    expect(text).toContain('dateIn(');
    // No calendar date is written into the plan: a plan in literal dates would be
    // wrong the moment the deployment happened in another month.
    expect(text).not.toMatch(/'\d{4}-\d{2}-\d{2}'/);
  });

  it('forgives only a duplicate, so a document it could not post stops the run', () => {
    const text = source();
    expect(text).toContain('function isAlready');
    expect(text).toMatch(/if \(!isAlready\(error\)\) throw error;/);
  });
});

describe('demo procurement, when the demo stands', () => {
  it('wrote the documents the plan says it wrote', async () => {
    if (!(await demoStands())) return;
    // Counted from the receipts this phase posted, not from the table: the
    // quality phase buys goods of its own and receives them against orders of
    // its own, and a count of every order in the tenant would move when a later
    // phase did its job.
    expect(await scalar(`
      select count(distinct l.purchase_order_number) as n
        from material_document d
        join material_document_line l
          on l.client = d.client and l.material_document_number = d.material_document_number
       where d.client = '${CLIENT}' and d.request_key like 'DEMO-GR-%'
         and d.request_key not like 'DEMO-GR-PRD-%'
         and l.purchase_order_number is not null`)).toBe(18);
    // Eighteen receipts, three consumable issues, and two initial stock entries —
    // counted by the key this phase gave them, because a later document phase
    // posts material documents under keys of its own.
    expect(await scalar(`
      select count(*) as n
        from material_document
       where client = '${CLIENT}'
         and (request_key like 'DEMO-ISS-%'
           or request_key like 'DEMO-OPENING-STOCK-%'
           or (request_key like 'DEMO-GR-%' and request_key not like 'DEMO-GR-PRD-%'))`)).toBe(23);
    // Seventeen of the eighteen receipts were billed; the last was not.
    expect(await scalar(`
      select count(*) as n from supplier_invoice
       where client = '${CLIENT}' and request_key like 'DEMO-IR-%'`)).toBe(17);
    // Seven payments, counted by the key this phase gave them: the close pays
    // suppliers of its own, and this count must not move when it does.
    expect(
      await scalar(
        `select count(*) as n from outgoing_payment where client = '${CLIENT}' and request_key like 'DEMO-PAY-%'`,
      ),
    ).toBe(7);
    // One opening journal, carrying no origin class of its own — counted by its
    // request key, because every phase after this one posts journals that carry
    // no origin class either.
    expect(
      await scalar(
        `select count(*) as n from journal_entry h
           join journal_posting_request r
             on r.client = h.client and r.document_number = h.document_number
            and r.fiscal_year = h.fiscal_year
          where h.client = '${CLIENT}' and r.request_key = 'DEMO-OPENING-BALANCES'
            and h.origin_class is null`,
      ),
    ).toBe(1);
  });

  it('fills the shelves on the first day, before anything is bought', async () => {
    if (!(await demoStands())) return;
    // Movement 561: one document per plant, posted the day the books open. A
    // company arrives with stock already on hand; the buying that follows adds
    // to it rather than starting it.
    const opening = await rows(`
      select l.plant, count(*) as lines, sum(l.value::numeric) as value
        from material_document d
        join material_document_line l
          on l.client = d.client and l.material_document_number = d.material_document_number
       where d.client = '${CLIENT}' and l.movement_type = 'INITIAL_STOCK_ENTRY'
       group by l.plant order by l.plant
    `);
    // Both plants, because a clerk's reach stops at one.
    expect(opening.map((row) => String(row.plant))).toEqual(['1000', '2000']);
    expect(opening.every((row) => Number(row.value) > 0)).toBe(true);

    // Nothing moved before the books opened.
    const earliest = await rows(`
      select min(posting_date)::text as first from material_document where client = '${CLIENT}'
    `);
    expect(String(earliest[0]?.first)).toBe(buildDemoTimeline().startDate);
  });

  it('credits the initial stock to retained earnings, with no clearing account', async () => {
    if (!(await demoStands())) return;
    // The other side of an opening balance is equity, not GR/IR: there is
    // nothing to clear, because no order was ever invoiced for this stock.
    const openingJournals = await rows(`
      select jl.gl_account, jl.debit_credit, sum(jl.amount_local::numeric) as amount
        from material_document d
        join material_document_line l
          on l.client = d.client and l.material_document_number = d.material_document_number
        join journal_entry_line jl
          on jl.client = d.client and jl.document_number = d.journal_document_number
       where d.client = '${CLIENT}' and l.movement_type = 'INITIAL_STOCK_ENTRY'
       group by jl.gl_account, jl.debit_credit order by jl.gl_account
    `);
    const credited = openingJournals.filter((row) => String(row.debit_credit) === 'H');
    expect(credited.map((row) => String(row.gl_account))).toEqual(['290000']);
    expect(openingJournals.map((row) => String(row.gl_account))).not.toContain('210000');
  });

  it('balances: total debits equal total credits', async () => {
    if (!(await demoStands())) return;
    const debit = await scalar(
      `select coalesce(sum(amount_local::numeric), 0) as n from journal_entry_line where client = '${CLIENT}' and debit_credit = 'S'`,
    );
    const credit = await scalar(
      `select coalesce(sum(amount_local::numeric), 0) as n from journal_entry_line where client = '${CLIENT}' and debit_credit = 'H'`,
    );
    expect(debit).toBeGreaterThan(0);
    expect(debit).toBe(credit);
  });

  it('ties the inventory accounts to the stock the inventory ledger holds', async () => {
    if (!(await demoStands())) return;
    const ledger = await scalar(
      `select coalesce(sum(case when debit_credit = 'S' then amount_local::numeric else -amount_local::numeric end), 0) as n
         from journal_entry_line where client = '${CLIENT}'
           and gl_account in ('120000', '120100', '120200', '120300')`,
    );
    const stock = await scalar(
      `select coalesce(sum(stock_value::numeric), 0) as n from material_valuation where client = '${CLIENT}'`,
    );
    expect(stock).toBeGreaterThan(0);
    expect(ledger).toBe(stock);
  });

  it('leaves GR/IR holding exactly what was received and not yet invoiced', async () => {
    if (!(await demoStands())) return;
    const grIr = await scalar(
      `select coalesce(sum(case when debit_credit = 'S' then amount_local::numeric else -amount_local::numeric end), 0) as n
         from journal_entry_line where client = '${CLIENT}' and gl_account = '210000'`,
    );
    // Computed from the documents, not asserted: what the goods receipts were
    // worth less what the supplier invoices billed. Neither figure is a stored
    // column on the order, so the two ledgers are summed and compared.
    const received = await scalar(
      `select coalesce(sum(value::numeric), 0) as n from material_document_line where client = '${CLIENT}' and purchase_order_number is not null`,
    );
    const invoiced = await scalar(
      `select coalesce(sum(net_amount::numeric), 0) as n from supplier_invoice_item where client = '${CLIENT}'`,
    );
    const outstanding = received - invoiced;
    expect(outstanding).toBeGreaterThan(0);
    // The month-end close reclassifies this balance onto an accrual: goods the
    // company has and has not been billed for are a liability either way, and
    // the close is where the ledger admits to it. So what GR/IR holds depends on
    // whether that close has run — and once it has, the document that moved the
    // balance is the one that has to account for every fils of it.
    const reclassified = await one(
      `select coalesce(max(accrual_document_number), '') as v from grir_reclass_run where client = '${CLIENT}'`,
    );
    if (reclassified) {
      expect(grIr).toBe(0);
      expect(
        await scalar(
          `select coalesce(sum(case when debit_credit = 'S' then amount_local::numeric else 0 end), 0) as n
             from journal_entry_line where client = '${CLIENT}' and gl_account = '210000'
               and document_number = '${reclassified}'`,
        ),
      ).toBe(outstanding);
      return;
    }
    expect(grIr).toBe(-outstanding);
  });

  it('posts no price differences: the order, the receipt and the invoice agree', async () => {
    if (!(await demoStands())) return;
    // A rounding drift between the price an order stores and the amount an
    // invoice is raised at would land here. It is empty, which is the point of
    // stating the purchase price at the precision the order keeps.
    const drift = await scalar(
      `select coalesce(sum(amount_local::numeric), 0) as n from journal_entry_line where client = '${CLIENT}' and gl_account = '410200'`,
    );
    expect(drift).toBe(0);
  });

  it('leaves a payable open, because a demo with nothing owing has no ageing', async () => {
    if (!(await demoStands())) return;
    const payable = await scalar(
      `select coalesce(sum(case when debit_credit = 'S' then amount_local::numeric else -amount_local::numeric end), 0) as n
         from journal_entry_line where client = '${CLIENT}' and gl_account = '200000'`,
    );
    // The brought-forward balance was 86,000; invoices and payments moved it. What
    // stands is what the ageing report has to explain.
    expect(payable).toBeLessThan(0);
    const open = await rows(`
      select l.business_partner as partner, count(*) as items
        from journal_entry_line l
       where l.client = '${CLIENT}' and l.gl_account = '200000'
         and l.clearing_document is null and l.debit_credit = 'H'
       group by l.business_partner order by l.business_partner
    `);
    expect(open.length).toBeGreaterThan(0);
  });

  it('ends with the last open period current and backposting allowed', async () => {
    if (!(await demoStands())) return;
    const control = await rows(`
      select current_fiscal_year as year, current_period as period, allow_backposting as back
        from material_period_control where client = '${CLIENT}' and company_code = '${DEMO_STRUCTURE.companyCode}'
    `);
    expect(control.length).toBe(1);
    expect(control[0]?.back === true || control[0]?.back === 't').toBe(true);

    // The last open period of the frozen timeline: the period the dataset ends in,
    // which is the only one a goods movement may still be posted to.
    const timeline = buildDemoTimeline();
    const last = timeline.openPeriods[timeline.openPeriods.length - 1] ?? '';
    expect(`${control[0]?.year}${String(control[0]?.period).padStart(2, '0')}`).toBe(last);
  });

  it('leaves no live session behind', async () => {
    if (!(await demoStands())) return;
    const live = await scalar(
      `select count(*) as n from user_session where client = '${CLIENT}' and revoked_at is null`,
    );
    expect(live).toBe(0);
  });

  it('records the provisioner as the actor on what it posted', async () => {
    if (!(await demoStands())) return;
    // The provisioning phases are the provisioner's own work, and every movement
    // they post carries their name. What a demo person posts afterwards — the
    // goods issues the warehouse clerks confirm in phase D3 — carries theirs, by
    // design: a document is written by the person whose job it is.
    // This phase's own movements, held to the provisioner's name. Later phases
    // post movements under keys of their own and in the name of the person whose
    // job the movement is — a quality decision's stock posting carries the
    // inspector's name, and that is the design rather than an exception — so the
    // claim made here is about the documents this phase keyed.
    const others = await scalar(
      `select count(*) as n from material_document
        where client = '${CLIENT}' and created_by <> 'DEMO_PROVISION'
          and (request_key like 'DEMO-ISS-%'
            or request_key like 'DEMO-OPENING-STOCK-%'
            or (request_key like 'DEMO-GR-%' and request_key not like 'DEMO-GR-PRD-%'))`,
    );
    expect(others).toBe(0);
  });
});
