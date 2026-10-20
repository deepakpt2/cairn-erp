/**
 * SCR-137 stage 2 — FB03 (FIN.JOURNAL.DISPLAY) index decision evidence.
 *
 * FB03 reads one document: its header by number and year, then its lines by the
 * same pair. The package proposes (tenant, company, number, year). This seeds
 * 40,000 documents of four lines in two company codes and times the two reads with
 * the standing keys, then with the package's candidate.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-fb03.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr137-fb03-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const HEADER = `select document_number, company_code, fiscal_year, document_type, posting_date
  from journal_entry where client = '${client}' and document_number = 'JE-039999' and fiscal_year = 2026`;
const HEADER_COMPANY = `select document_number from journal_entry
  where client = '${client}' and document_number = 'JE-039999' and fiscal_year = 2026 and company_code = '1000'`;
const LINES = `select line_number, gl_account, debit_credit, amount_local::text
  from journal_entry_line where client = '${client}' and document_number = 'JE-039999' and fiscal_year = 2026
  order by line_number`;

const T0 = Date.now();
const lap = (l: string) => console.log(`  · ${l} ${Date.now() - T0} ms`);

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into journal_entry (client, document_number, display_number, fiscal_year, document_type, company_code,
                                 document_date, posting_date, posting_period, document_currency, local_currency, created_by)
      select ${client}, 'JE-' || lpad(g::text, 6, '0'), '', 2026,
             'SA', case when g % 2 = 0 then '1000' else '2000' end, '2026-04-01', '2026-04-01', 4, 'KWD', 'KWD', 'plan'
      from generate_series(1, 40000) g`);
    lap('headers');
    await tx.execute(sql`
      insert into journal_entry_line (client, document_number, fiscal_year, line_number, gl_account, company_code,
                                      debit_credit, amount_local, amount_document, currency)
      select ${client}, 'JE-' || lpad(g::text, 6, '0'), 2026, l,
             case when l % 2 = 1 then '400000' else '120000' end,
             case when g % 2 = 0 then '1000' else '2000' end,
             case when l % 2 = 1 then 'S' else 'H' end,
             100, 100, 'KWD'
      from generate_series(1, 40000) g cross join generate_series(1, 4) l`);
    lap('lines');
    await tx.execute(sql`analyze journal_entry`);
    await tx.execute(sql`analyze journal_entry_line`);
    lap('analyzed');
  });
  console.log('seeded');

  const measure = async (label: string, statement: string) => {
    const plan = await withTenant(client, (tx) => tx.execute(sql.raw(
      `explain (analyze, costs off, timing off) ${statement}`,
    ))) as unknown as Array<Record<string, string>>;
    const text = plan.map((r) => Object.values(r)[0]).join('\n');
    const execution = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const indexes = [...text.matchAll(/Index (?:Only )?Scan using ([\w_]+)/g)].map((m) => m[1]).join(', ') || 'seq scan';
    console.log(`[${label}] ${execution} ms  ->  ${indexes}`);
  };

  console.log('—— standing keys: the three reads ——');
  await measure('header by number+year ', HEADER);
  await measure('header + company      ', HEADER_COMPANY);
  await measure('the document’s lines  ', LINES);

  await ddl`create index fb03_cand on journal_entry (client, company_code, document_number, fiscal_year)`;
  await ddl`analyze journal_entry`;
  console.log('—— with the package-shaped candidate (company first) ——');
  await measure('header by number+year ', HEADER);
  await measure('header + company      ', HEADER_COMPANY);
  await measure('the document’s lines  ', LINES);
  await ddl`drop index fb03_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
