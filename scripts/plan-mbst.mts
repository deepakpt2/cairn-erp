/**
 * SCR-132 stage 2 — MBST (INV.REVERSE) index decision evidence.
 *
 * Seeds 20,000 material documents of three lines each (60,000 lines) and 5,000
 * reversal lines that name their originals, then times the reads a reversal
 * issues: the original header, its lines, and — the one shape that has no index
 * today — the per-line reversed quantity read off `reversal_of_document`.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mbst.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr132-mbst-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const HEADER = `select status, reversal_of, reversed_by from material_document
  where client = '${client}' and material_document_number = 'MD-00010000'`;
const LINES = `select line_number, line_direction, base_quantity from material_document_line
  where client = '${client}' and material_document_number = 'MD-00010000' order by line_number`;
const REVERSED = `select reversal_of_line, sum(base_quantity) as q from material_document_line
  where client = '${client}' and reversal_of_document = 'MD-00010000' group by reversal_of_line`;

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${client}, 'Q6', 'Plan plant', 'KW', 'plan')
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-PLAN', 'Plan', t.material_type, 'PC', 'plan'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      values (${client}, 'Q6', 'SL01', 'Store', true, 'plan')
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, reversal_movement_type, created_by)
      values (${client}, 'PLAN_RECEIPT', 'Plan receipt', 'RECEIPT', 'MATERIAL_DOCUMENT', 'PLAN_REVERSAL', 'plan'),
             (${client}, 'PLAN_REVERSAL', 'Plan reversal', 'REVERSAL', 'MATERIAL_DOCUMENT', null, 'plan')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by)
      select ${client}, 'MD-' || lpad(g::text, 8, '0'), 2026, '2026-09-01', '2026-09-01', 'Plan', 'POSTED', 'plan'
      from generate_series(1, 20000) g
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, storage_location, stock_type, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, created_by)
      select ${client}, 'MD-' || lpad(g::text, 8, '0'), l, 'PLAN_RECEIPT', 'MAT-PLAN', 'Q6', 'SL01', 'UNRESTRICTED',
             1, 'PC', 1, 'PC', 0, 'plan'
      from generate_series(1, 20000) g cross join generate_series(1, 3) l
    `);
    // 5,000 reversal documents, each naming one original document's first line.
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, reversal_of, created_by)
      select ${client}, 'RV-' || lpad(g::text, 8, '0'), 2026, '2026-09-02', '2026-09-02', 'Plan', 'POSTED',
             'MD-' || lpad(g::text, 8, '0'), 'plan'
      from generate_series(1, 5000) g
    `);
    await tx.execute(sql`
      insert into material_document_line (client, material_document_number, line_number, movement_type, material_number,
                                          plant, storage_location, stock_type, entry_quantity, entry_unit,
                                          base_quantity, base_unit, value, reversal_of_document, reversal_of_line, created_by)
      select ${client}, 'RV-' || lpad(g::text, 8, '0'), 1, 'PLAN_REVERSAL', 'MAT-PLAN', 'Q6', 'SL01', 'UNRESTRICTED',
             1, 'PC', 1, 'PC', 0, 'MD-' || lpad(g::text, 8, '0'), 1, 'plan'
      from generate_series(1, 5000) g
    `);
    await tx.execute(sql`analyze material_document`);
    await tx.execute(sql`analyze material_document_line`);
  });
  console.log('seeded');

  const measure = async (label: string, statement: string) => {
    const plan = await withTenant(client, (tx) => tx.execute(sql.raw(
      `explain (analyze, costs off, timing off) ${statement}`,
    ))) as unknown as Array<Record<string, string>>;
    const text = plan.map((r) => Object.values(r)[0]).join('\n');
    const execution = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const indexes = [...text.matchAll(/Index (?:Only )?Scan using (\w+)/g)].map((m) => m[1]).join(', ') || 'seq scan';
    console.log(`[${label}] ${execution} ms  ->  ${indexes}`);
  };

  console.log('—— standing indexes: the three reads a reversal issues ——');
  await measure('header  ', HEADER);
  await measure('lines   ', LINES);
  await measure('reversed', REVERSED);

  await ddl`create index mbst_reversal_cand on material_document_line (client, reversal_of_document)`;
  await ddl`analyze material_document_line`;
  console.log('—— with a candidate on the reversal link ——');
  await measure('header  ', HEADER);
  await measure('lines   ', LINES);
  await measure('reversed', REVERSED);
  await ddl`drop index mbst_reversal_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
