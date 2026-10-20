/**
 * SCR-135 stage 2 — MB90 (INV.MATERIALDOC.RECEIVEPRINT) index decision evidence.
 *
 * Seeds 40,000 material documents of two lines each and one output message per
 * document, then times what MB90 asks of the queue: the grid by status (optionally
 * by output type), the periodic run's read of pending messages, and one document's
 * messages by its primary key.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb90.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr135-mb90-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const GRID = `select material_document_number, output_type, status, send_count
  from output_message where client = '${client}' and status = 'PENDING' order by created_at desc limit 200`;
const GRID_TYPED = `select material_document_number, output_type, status, send_count
  from output_message where client = '${client}' and output_type = 'WE01' and status = 'PENDING'
  order by created_at desc limit 200`;
const RUN = `select material_document_number from output_message
  where client = '${client}' and status = 'PENDING' and dispatch_time = 'PERIODIC' order by created_at limit 500`;
const ONE_DOC = `select output_type, transmission_medium, status from output_message
  where client = '${client}' and material_document_number = '4900003999'`;

const T0 = Date.now();
const lap = (l: string) => console.log(`  · ${l} ${Date.now() - T0} ms`);

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by)
      values (${client}, 'RECEIPT_OTHER', 'Other receipt', 'RECEIPT', 'MATERIAL_DOCUMENT', 'plan') on conflict do nothing`);
    await tx.execute(sql`
      insert into output_type (client, output_type, description, direction, transmission_medium, dispatch_time, created_by) values
        (${client}, 'WE01', 'Goods receipt slip', 'RECEIPT', 'PRINT', 'IMMEDIATE', 'plan'),
        (${client}, 'WA01', 'Goods issue slip', 'ISSUE', 'PRINT', 'PERIODIC', 'plan') on conflict do nothing`);
    lap('catalogue');
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, created_by)
      select ${client}, (4900000000 + g)::text, 2024 + (g % 3), '2026-01-15', '2026-01-15', 'seeded', 'plan'
      from generate_series(1, 40000) g`);
    lap('documents');
    await tx.execute(sql`
      insert into output_message (client, material_document_number, document_year, output_type,
                                  transmission_medium, dispatch_time, status, created_by)
      select ${client}, (4900000000 + g)::text, 2024 + (g % 3),
             case when g % 5 = 0 then 'WA01' else 'WE01' end, 'PRINT',
             case when g % 5 = 0 then 'PERIODIC' else 'IMMEDIATE' end,
             case when g % 3 = 0 then 'PROCESSED' else 'PENDING' end, 'plan'
      from generate_series(1, 40000) g`);
    lap('messages');
    await tx.execute(sql`analyze output_message`);
    lap('analyzed');
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

  console.log('—— standing keys: the four reads ——');
  await measure('grid by status   ', GRID);
  await measure('grid + output type', GRID_TYPED);
  await measure('periodic run     ', RUN);
  await measure('one document     ', ONE_DOC);

  await ddl`create index mb90_grid_cand on output_message (client, status, output_type)`;
  await ddl`analyze output_message`;
  console.log('—— with the package-shaped candidate (status, then type) ——');
  await measure('grid by status   ', GRID);
  await measure('grid + output type', GRID_TYPED);
  await measure('periodic run     ', RUN);
  await measure('one document     ', ONE_DOC);
  await ddl`drop index mb90_grid_cand`;

  await ddl`create index mb90_shape_cand on output_message (client, status, created_at)`;
  await ddl`analyze output_message`;
  console.log('—— with the query-shaped candidate (status, then time) ——');
  await measure('grid by status   ', GRID);
  await measure('grid + output type', GRID_TYPED);
  await measure('periodic run     ', RUN);
  await measure('one document     ', ONE_DOC);
  await ddl`drop index mb90_shape_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
