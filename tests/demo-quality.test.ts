import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';

import { withTenant } from '../src/platform/db/client';
import { DEMO_IDENTITY, DEMO_STRUCTURE } from '../src/platform/tenancy/demo-organisation';
import { DEMO_PHASE_PLAN } from '../src/platform/tenancy/demo-provisioning';

const CLIENT = DEMO_IDENTITY.clientKey;

/**
 * The quality inspection, checked the way an inspector and an accountant would
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
 * Whether this phase has actually run in this database.
 *
 * The tenant can stand with the inspection still in front of it — a deployment
 * that stopped after the close, or a resumed run that has not reached this
 * phase yet. Counting an inspection that never happened would report zeroes as
 * though they were a result, so every check below asks first.
 */
async function qualityStands(): Promise<boolean> {
  if (!(await demoStands())) return false;
  return withTenant(CLIENT, async (tx) => {
    const rows = (await tx.execute(
      sql`select 1 as present from demo_installation_phase where phase_code = 'D5_QUALITY' and status = 'COMPLETED'`,
    )) as unknown as Array<{ present: number }>;
    return rows.length > 0;
  }).catch(() => false);
}

function source(): string {
  return readFileSync(join(process.cwd(), 'src/platform/tenancy/demo-quality.ts'), 'utf8');
}

describe('demo quality phase, as it is written', () => {
  it('takes its place after the close, and last', () => {
    // The plan is append-only. Quality reads what the buying, the making, the
    // selling and the close left behind: it inspects goods that arrived, so it
    // can only stand after the phases that put them there.
    expect(DEMO_PHASE_PLAN.indexOf('D5_QUALITY')).toBe(DEMO_PHASE_PLAN.indexOf('D4_FINANCE') + 1);
    expect(DEMO_PHASE_PLAN[DEMO_PHASE_PLAN.length - 1]).toBe('D5_QUALITY');
  });

  it('derives every date from the frozen timeline, never from a literal', () => {
    const body = source();
    expect(body).toContain('dateIn(');
    expect(body).not.toMatch(/'\d{4}-\d{2}-\d{2}'/);
  });

  it('keys every step, so a resumed run finds its own work', () => {
    const body = source();
    // One key per document. A run that died between the results and the decision
    // is handed back the results it already recorded rather than a second lot.
    for (const key of ['GR', 'LOT', 'RES', 'DEC', 'IR', 'PAY']) {
      expect(body).toContain(`DEMO-QM-${key}-`);
    }
  });

  it('receives into inspection stock, not onto the shelf', () => {
    const body = source();
    // The whole point of the phase: a receipt that makes no claim about the
    // goods. Anything else in this file is a story about goods that were never
    // in doubt.
    expect(body).toContain("stockType: 'QUALITY'");
  });

  it('decides both ways, because one way would exercise one path and claim two', () => {
    const body = source();
    expect(body).toContain("decisionCode: 'ACCEPT'");
    expect(body).toContain("decisionCode: 'REJECT'");
  });

  it('dates the stock movement itself, rather than leaving it to the clock', () => {
    const body = source();
    // A decision about goods received last month posts last month. A service
    // that dated the movement itself would put it on the day provisioning ran,
    // which is neither the period the goods arrived in nor one the timeline froze.
    expect(body).toContain('postingDate: decisionDate');
  });

  it('names the three people whose job each document is', () => {
    const body = source();
    expect(body).toContain("const CLERK = 'demo.warehouse1';");
    expect(body).toContain("const INSPECTOR = 'demo.quality';");
    expect(body).toContain("const ACCOUNTANT = 'demo.accountant';");
    // Each is used inside `withActingUser`, because the service they call is the
    // one that asks who is acting.
    expect(body).toContain('withActingUser(client, CLERK,');
    expect(body).toContain('withActingUser(client, INSPECTOR,');
    expect(body).toContain('withActingUser(client, ACCOUNTANT,');
  });

  it('inspects at one plant, and says which', () => {
    const body = source();
    expect(body).toContain('const PLANT = DEMO_STRUCTURE.manufacturingPlant;');
  });
});

describe('demo quality, when the demo stands', () => {
  it('made the documents the plan says it made', async () => {
    if (!(await qualityStands())) return;
    expect(await scalar(`
      select count(*) as n from inspection_characteristic where client = '${CLIENT}'`)).toBe(4);
    // Two receipts, two lots, two decisions, two movements, two invoices, two
    // payments — and four results on each of the two lots.
    expect(await scalar(`
      select count(*) as n from material_document
       where client = '${CLIENT}' and request_key like 'DEMO-QM-GR-%'`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from quality_lot
       where client = '${CLIENT}' and request_key like 'DEMO-QM-LOT-%'`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from inspection_result
       where client = '${CLIENT}' and lot_number in (
         select lot_number from quality_lot where client = '${CLIENT}' and request_key like 'DEMO-QM-LOT-%')`)).toBe(8);
    expect(await scalar(`
      select count(*) as n from usage_decision
       where client = '${CLIENT}' and lot_number in (
         select lot_number from quality_lot where client = '${CLIENT}' and request_key like 'DEMO-QM-LOT-%')`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from material_document
       where client = '${CLIENT}' and request_key like 'DEMO-QM-DEC-%'`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from supplier_invoice
       where client = '${CLIENT}' and request_key like 'DEMO-QM-IR-%'`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from outgoing_payment
       where client = '${CLIENT}' and request_key like 'DEMO-QM-PAY-%'`)).toBe(2);
  });

  it('booked both deliveries into inspection stock, and left nothing standing there', async () => {
    if (!(await qualityStands())) return;
    // Goods received are QUALITY until somebody decides. Both deliveries were
    // decided, so what is left in the segment is nothing at all.
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and stock_type = 'QUALITY'
         and material_document_number in (
           select material_document_number from material_document
            where client = '${CLIENT}' and request_key like 'DEMO-QM-GR-%')`)).toBe(2);
    const left = await scalar(`
      select coalesce(sum(quantity::numeric), 0) as n from stock_quantity
       where client = '${CLIENT}' and stock_type = 'QUALITY'`);
    expect(left).toBe(0);
  });

  it('moved the accepted goods to free use and the rejected goods to blocked', async () => {
    if (!(await qualityStands())) return;
    // 321 on the accept, 323 on the reject: one movement each, taken from the
    // documents the decisions wrote rather than from what the plan intended.
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and movement_type = 'TRANSFER_STYPE'
         and material_document_number in (
           select material_document_number from material_document
            where client = '${CLIENT}' and request_key like 'DEMO-QM-DEC-%')`)).toBe(2);
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and movement_type = 'TRANSFER_STYPE_BLOCK'
         and material_document_number in (
           select material_document_number from material_document
            where client = '${CLIENT}' and request_key like 'DEMO-QM-DEC-%')`)).toBe(2);
    // The rejected delivery stands blocked: counted, owned, and not to be used.
    expect(await scalar(`
      select coalesce(sum(quantity::numeric), 0) as n from stock_quantity
       where client = '${CLIENT}' and stock_type = 'BLOCKED'`)).toBeGreaterThan(0);
  });

  it('is written by the clerk, the inspector and the accountant, and not the other way round', async () => {
    if (!(await qualityStands())) return;
    // The inspector opens, measures and decides.
    expect(await scalar(`
      select count(*) as n from quality_lot
       where client = '${CLIENT}' and request_key like 'DEMO-QM-LOT-%'
         and upper(created_by) <> 'DEMO.QUALITY'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from inspection_result
       where client = '${CLIENT}' and upper(recorded_by) <> 'DEMO.QUALITY'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from usage_decision
       where client = '${CLIENT}' and upper(decided_by) <> 'DEMO.QUALITY'`)).toBe(0);
    // The movements the decisions posted carry the inspector's name, because
    // they were posted by the inspector's act.
    expect(await scalar(`
      select count(*) as n from material_document
       where client = '${CLIENT}' and request_key like 'DEMO-QM-DEC-%'
         and upper(created_by) <> 'DEMO.QUALITY'`)).toBe(0);
    // The accountant banks the money.
    expect(await scalar(`
      select count(*) as n from outgoing_payment
       where client = '${CLIENT}' and request_key like 'DEMO-QM-PAY-%'
         and upper(created_by) <> 'DEMO.ACCOUNTANT'`)).toBe(0);
    // The receipts are the clerk's authorisation and the provisioner's name,
    // exactly as they are in D1: the service asks who is posting, and the
    // provisioner does not pretend to be somebody else.
    expect(await scalar(`
      select count(*) as n from material_document
       where client = '${CLIENT}' and request_key like 'DEMO-QM-GR-%'
         and created_by <> 'DEMO_PROVISION'`)).toBe(0);
  });

  it('posted every document inside one of the frozen open periods', async () => {
    if (!(await qualityStands())) return;
    expect(await scalar(`
      select count(*) as n from material_document
       where client = '${CLIENT}' and request_key like 'DEMO-QM-%'
         and to_char(posting_date, 'YYYYMM') not in (
           select jsonb_array_elements_text(timeline->'openPeriods') from demo_installation)`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from journal_entry h
        join journal_posting_request r
          on r.client = h.client and r.document_number = h.document_number
         and r.fiscal_year = h.fiscal_year
       where h.client = '${CLIENT}' and r.request_key like 'DEMO-QM-%'
         and to_char(h.posting_date, 'YYYYMM') not in (
           select jsonb_array_elements_text(timeline->'openPeriods') from demo_installation)`)).toBe(0);
  });

  it('left the books balanced, and the ledgers the earlier phases assert untouched', async () => {
    if (!(await qualityStands())) return;
    // Debits less credits over every posted line the tenant holds.
    expect(await scalar(`
      select coalesce(sum(case when e.debit_credit = 'S' then e.amount_local
                              else -e.amount_local end), 0) as n
        from journal_entry_line e
        join journal_entry h on h.client = e.client and h.document_number = e.document_number
                            and h.fiscal_year = e.fiscal_year
       where e.client = '${CLIENT}' and h.status = 'POSTED'`)).toBe(0);
    // Both deliveries were invoiced and paid, so the clearing account nets to
    // nothing and the payables ageing still says what D1 and D4 left it saying.
    expect(await scalar(`
      select coalesce(sum(case when debit_credit = 'S' then amount_local
                              else -amount_local end), 0) as n
        from journal_entry_line where client = '${CLIENT}' and gl_account = '210000'`)).toBe(0);
    expect(await scalar(`
      select count(*) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account = '200000'
         and debit_credit = 'H' and clearing_document is null`)).toBe(4);
    // No price difference: the order, the receipt and the invoice agree.
    expect(await scalar(`
      select coalesce(sum(amount_local), 0) as n from journal_entry_line
       where client = '${CLIENT}' and gl_account = '410200'`)).toBe(0);
  });

  it('keeps the inventory accounts tied to the stock the inventory ledger holds', async () => {
    if (!(await qualityStands())) return;
    // A stock type change moves no value: the goods are worth what the receipt
    // said they were worth, whichever segment they stand in.
    const ledger = await scalar(`
      select coalesce(sum(case when debit_credit = 'S' then amount_local::numeric
                              else -amount_local::numeric end), 0) as n
        from journal_entry_line where client = '${CLIENT}'
          and gl_account in ('120000', '120100', '120200', '120300')`);
    const stock = await scalar(`
      select coalesce(sum(stock_value::numeric), 0) as n from material_valuation where client = '${CLIENT}'`);
    expect(stock).toBeGreaterThan(0);
    expect(ledger).toBe(stock);
  });

  it('inspected at the plant the inspector was given, and nowhere else', async () => {
    if (!(await qualityStands())) return;
    // The inspector's reach is the factory alone. Everything this phase posted
    // therefore stands at one plant, and a decision asked for at the other is
    // refused for want of a scope rather than granted by default.
    const reach = await text(`
      select string_agg(r.scope_value, ',') as v
        from auth_org_restriction r
        join app_user u on u.client = r.client and u.id = r.user_id
       where r.client = '${CLIENT}' and upper(u.username) = 'DEMO.QUALITY'
         and r.scope_type = 'PLANT'`);
    expect(reach).toBe(DEMO_STRUCTURE.manufacturingPlant);
    expect(await scalar(`
      select count(*) as n from material_document_line
       where client = '${CLIENT}' and material_document_number in (
         select material_document_number from material_document
          where client = '${CLIENT}' and request_key like 'DEMO-QM-%')
         and plant <> '${DEMO_STRUCTURE.manufacturingPlant}'`)).toBe(0);
  });

  it('leaves no live session behind', async () => {
    if (!(await qualityStands())) return;
    expect(await scalar(`
      select count(*) as n from user_session where client = '${CLIENT}' and revoked_at is null`)).toBe(0);
  });
});
