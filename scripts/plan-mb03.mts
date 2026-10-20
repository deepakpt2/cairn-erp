/**
 * SCR-134 stage 2 — MB03 (INV.DISPLAY) index decision evidence.
 *
 * Seeds 5,000 material documents of three lines each (15,000 lines) over three
 * fiscal years, then times what a display reads: one document's header by its
 * number, its lines, and the same header read the way the package's composite key
 * words it — number and year together — against a candidate that leads with the
 * year.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb03.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr134-mb03-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const HEADER = `select material_document_number, document_year, posting_date, header_text, status
  from material_document where client = '${client}' and material_document_number = '4900004998'`;
const HEADER_WITH_YEAR = `select material_document_number, document_year, posting_date, header_text, status
  from material_document where client = '${client}' and material_document_number = '4900004998' and document_year = 2026`;
const LINES = `select line_number, movement_type, material_number, plant, base_quantity::text
  from material_document_line where client = '${client}' and material_document_number = '4900004998' order by line_number`;

const T0 = Date.now();
const lap = (l: string) => console.log(`  · ${l} ${Date.now() - T0} ms`);

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'RECEIPT_OTHER', 'Other receipt', 'RECEIPT', 'MATERIAL_DOCUMENT', 'plan') on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, created_by)
      select ${client}, (4900000000 + g)::text, 2024 + (g % 3), '2026-01-15', '2026-01-15', 'seeded', 'plan'
      from generate_series(1, 5000) g
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, base_quantity, base_unit, entry_quantity, entry_unit, created_by)
      select ${client}, (4900000000 + g)::text, l, 'RECEIPT_OTHER',
             'MAT-' || lpad(((g % 5000) + 1)::text, 5, '0'), '1000', 1, 'PC', 1, 'PC', 'plan'
      from generate_series(1, 5000) g cross join generate_series(1, 3) l
    `);
    lap('seeded');
    await tx.execute(sql`analyze material_document`);
    lap('analyzed header');
    await tx.execute(sql`analyze material_document_line`);
    lap('analyzed lines');
  });
  console.log('seeded');
  lap('transaction closed');

  const measure = async (label: string, statement: string) => {
    const plan = await withTenant(client, (tx) => tx.execute(sql.raw(
      `explain (analyze, costs off, timing off) ${statement}`,
    ))) as unknown as Array<Record<string, string>>;
    const text = plan.map((r) => Object.values(r)[0]).join('\n');
    const execution = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const indexes = [...text.matchAll(/Index (?:Only )?Scan using (\w+)/g)].map((m) => m[1]).join(', ') || 'seq scan';
    console.log(`[${label}] ${execution} ms  ->  ${indexes}`);
  };

  console.log('—— standing keys: the three reads ——');
  await measure('header by number ', HEADER);
  await measure('header + year    ', HEADER_WITH_YEAR);
  await measure('lines of document', LINES);

  await ddl`create index mb03_lookup_cand on material_document (client, document_year, material_document_number)`;
  await ddl`analyze material_document`;
  console.log('—— with the package-shaped candidate (year first) ——');
  await measure('header by number ', HEADER);
  await measure('header + year    ', HEADER_WITH_YEAR);
  await measure('lines of document', LINES);
  await ddl`drop index mb03_lookup_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
