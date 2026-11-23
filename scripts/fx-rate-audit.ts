/**
 * Audit foreign-currency postings made before rate provenance was recorded.
 *
 * This is a read-only report. It never rewrites a document and never guesses which historical
 * postings are wrong. A document in a foreign currency with `exchange_rate = 1` is a candidate:
 *
 *   - POSSIBLE_DEFAULT — no rate provenance at all (posted before 9330). It may have been
 *     translated at a default 1, or an explicit 1 may have been correct for that date/pair.
 *   - EXPLICIT_ONE — provenance stands and the effective rate really was 1. Finance reviews it
 *     but normally leaves it alone.
 *   - FOREIGN_OTHER — a foreign document with a non-1 rate and provenance. Shown for context.
 *
 * Run against the intended database with DATABASE_URL set. The target guard refuses protected
 * databases. Exit codes: 0 report produced, 1 configuration/connection failure.
 */
import postgres from 'postgres';

import { validateTarget } from '../src/platform/db/target-guard';

interface Row {
  company_code: string;
  document_currency: string;
  local_currency: string;
  document_type: string;
  exchange_rate: string;
  rate_source: string | null;
  rate_valid_from: string | null;
  documents: number;
  first_posting: string;
  last_posting: string;
}

function classOf(row: Row): 'POSSIBLE_DEFAULT' | 'EXPLICIT_ONE' | 'FOREIGN_OTHER' {
  const rateOne = Number(row.exchange_rate) === 1;
  if (!row.rate_source && rateOne) return 'POSSIBLE_DEFAULT';
  if (rateOne) return 'EXPLICIT_ONE';
  return 'FOREIGN_OTHER';
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required; no database was contacted.');
    process.exitCode = 1;
    return;
  }
  const database = new URL(url).pathname.replace(/^\//, '');
  await validateTarget(database, undefined, url);

  const sql = postgres(url, { max: 1 });
  try {
    const rows = (await sql`
      select company_code,
             document_currency,
             local_currency,
             document_type,
             exchange_rate::text as exchange_rate,
             rate_source,
             rate_valid_from::text as rate_valid_from,
             count(*)::int as documents,
             min(posting_date)::text as first_posting,
             max(posting_date)::text as last_posting
        from journal_entry
       where document_currency <> local_currency
         and status <> 'PARKED'
       group by company_code, document_currency, local_currency, document_type,
                exchange_rate, rate_source, rate_valid_from
       order by company_code, document_currency, document_type, exchange_rate
    `) as unknown as Row[];

    const classified = rows.map((row) => ({ ...row, classification: classOf(row) }));
    const candidates = classified.filter((row) => row.classification === 'POSSIBLE_DEFAULT');
    const explicitOne = classified.filter((row) => row.classification === 'EXPLICIT_ONE');
    const other = classified.filter((row) => row.classification === 'FOREIGN_OTHER');

    console.log(`Foreign-currency posting audit for database ${database}`);
    console.log('Read-only. No document is changed and no rate is inferred.');
    console.log('');
    console.log(`POSSIBLE_DEFAULT (no provenance, rate 1): ${candidates.length} grouping(s), ${sum(candidates)} document(s)`);
    if (candidates.length > 0) {
      console.table(candidates.map((row) => ({
        Company: row.company_code,
        Document: row.document_currency,
        Local: row.local_currency,
        Type: row.document_type,
        Rate: row.exchange_rate,
        Documents: row.documents,
        First: row.first_posting,
        Last: row.last_posting,
      })));
      console.log('');
      console.log('Finance review: for each grouping, compare the posting dates with the AVERAGE rate master');
      console.log('(OB08) and the source documents. An explicit 1 that was correct on that date is a false');
      console.log('positive. Where a posting is wrong, correct it with a new adjusting document at the');
      console.log('appropriate rate; never rewrite the historical posting. Sorting and clearing follow the');
      console.log('ordinary reversal workflow so the original and its mirror both remain in the ledger.');
    }
    console.log('');
    console.log(`EXPLICIT_ONE (provenance present, rate 1): ${explicitOne.length} grouping(s), ${sum(explicitOne)} document(s)`);
    console.log(`FOREIGN_OTHER (provenance present, non-1 rate): ${other.length} grouping(s), ${sum(other)} document(s)`);
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify({ database, candidates, explicitOne, other }, null, 2));
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function sum(rows: Array<{ documents: number }>): number {
  return rows.reduce((total, row) => total + row.documents, 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'The FX audit failed; connection values withheld.');
  process.exitCode = 1;
});
