/**
 * SCR-126 stage 2 — MB5B (INV.STOCK.POSTINGDATE) index decision evidence.
 *
 * Seeds a throwaway tenant with 40,000 ledger lines over 10 plants, 50 materials
 * and 4 storage locations across a year, then times the rollforward the service
 * will issue: one pass over the ledger up to the end date, folded into opening
 * (before the start), receipts and issues (inside the window) per material,
 * plant, storage location and stock type. Measured on top of the posting-date
 * index taken at SCR-125, with and without the line plant/material index the
 * package recommends.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb5b.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr126-mb5b-plan');
const client = tenant.client;

async function seed() {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, 'Q10' || g, 'Plant ' || g, 'KW', 'plan' from generate_series(0, 9) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-' || lpad(g::text, 5, '0'), 'Material ' || g, t.material_type, 'PC', 'plan'
      from generate_series(1, 50) g
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      select ${client}, 'Q10' || (g % 10), 'SL0' || g, 'Location ' || g, true, 'plan'
      from generate_series(0, 3) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'plan'),
        (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', 'plan')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document (client, material_document_number, document_year, document_date, posting_date, header_text, status, created_by)
      select ${client}, '49' || lpad(g::text, 8, '0'), 2025,
             (date '2025-01-01' + (g % 365)::int), (date '2025-01-01' + (g % 365)::int), 'Ledger', 'POSTED', 'plan'
      from generate_series(1, 10000) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant, storage_location,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit, unit_price, price_unit, currency, value,
        purchase_order_number, purchase_order_item, created_by
      )
      select ${client}, '49' || lpad(g::text, 8, '0'), k,
             'GOODS_RECEIPT_PO', 'MAT-' || lpad((((g + k) % 50) + 1)::text, 5, '0'),
             'Q10' || ((g + k) % 10), 'SL0' || ((g + k) % 4), 'UNRESTRICTED',
             2::numeric, 'PC', 2::numeric, 'PC', 10::numeric, 1, 'USD', 20::numeric, null, null, 'plan'
      from generate_series(1, 10000) g cross join generate_series(1, 4) k
    `);
  });
}

const cases: Array<[string, string, string, string, string, string]> = [
  ['narrow   material MAT-00007, one plant, 1 month', 'MAT-00007', 'MAT-00007', 'Q100', 'Q100', '2025-06-01', '2025-06-30'],
  ['plant    plants Q100-Q104, 5 materials, 3 months', 'MAT-00001', 'MAT-00005', 'Q100', 'Q104', '2025-04-01', '2025-06-30'],
  ['broad    all materials, all plants, 12 months', 'MAT-00001', 'MAT-00050', 'Q100', 'Q109', '2025-01-01', '2025-12-31'],
];

const rollforward = (mFrom: string, mTo: string, pFrom: string, pTo: string, dFrom: string, dTo: string) => sql`
  select l.material_number, l.plant, l.storage_location, l.stock_type, l.base_unit,
         sum(case when d.posting_date < ${dFrom}
                  then (case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end)
                  else 0 end) as opening_qty,
         sum(case when d.posting_date >= ${dFrom} and m.direction <> 'REVERSAL' then l.base_quantity else 0 end) as receipt_qty,
         sum(case when d.posting_date >= ${dFrom} and m.direction = 'REVERSAL' then l.base_quantity else 0 end) as issue_qty,
         sum(case when d.posting_date < ${dFrom}
                  then (case when m.direction = 'REVERSAL' then -l.value else l.value end)
                  else 0 end) as opening_val,
         sum(case when d.posting_date >= ${dFrom} and m.direction <> 'REVERSAL' then l.value else 0 end) as receipt_val,
         sum(case when d.posting_date >= ${dFrom} and m.direction = 'REVERSAL' then l.value else 0 end) as issue_val
  from material_document_line l
  join material_document d on d.client = l.client and d.material_document_number = l.material_document_number
  join movement_type m on m.client = l.client and m.movement_type = l.movement_type
  where l.client = ${client} and d.status = 'POSTED'
    and l.material_number between ${mFrom} and ${mTo}
    and l.plant between ${pFrom} and ${pTo}
    and d.posting_date <= ${dTo}
  group by l.material_number, l.plant, l.storage_location, l.stock_type, l.base_unit
  order by l.material_number, l.plant, l.storage_location, l.stock_type
  limit 501
`;

async function measure(tag: string, args: string[]) {
  const [mFrom, mTo, pFrom, pTo, dFrom, dTo] = args;
  await withTenant(client, async (tx) => {
    const plan = (await tx.execute(sql`explain (analyze, buffers, costs) ${rollforward(mFrom, mTo, pFrom, pTo, dFrom, dTo)}`)) as unknown as Array<Record<string, string>>;
    const lines = plan.map((row) => Object.values(row)[0] as string);
    const exec = (lines.find((l) => l.includes('Execution Time')) ?? '').replace('Execution Time: ', '').trim();
    const scans = lines
      .filter((l) => /Scan|Join|Limit|Aggregate/.test(l) && !/Workers|Buffers|Filter|Hash Cond|Sort Key|Sort Method|Rows Removed/.test(l))
      .map((l) => l.trim().replace(/\s*\(cost=.*$/, ''))
      .slice(0, 6);
    console.log(`[${tag}] ${exec}`);
    for (const scan of scans) console.log(`    ${scan}`);
  });
}

const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!migrationUrl) throw new Error('No migration URL configured');
const admin = postgres(migrationUrl, { max: 1, prepare: false, onnotice: () => {} });

try {
  await seed();
  await admin.unsafe(`analyze material_document`);
  await admin.unsafe(`analyze material_document_line`);

  const counts = (await withTenant(client, async (tx) => tx.execute(sql`
    select (select count(*) from material_document_line where client = ${client}) as lines
  `))) as unknown as Array<Record<string, string>>;
  console.log('counts', JSON.stringify(counts[0]));

  for (const [label, ...args] of cases) await measure('standing-index ' + label, args);

  await admin.unsafe(`create index if not exists mdl_plant_material_idx on material_document_line (client, plant, material_number)`);
  await admin.unsafe(`analyze material_document_line`);
  for (const [label, ...args] of cases) await measure('with-line-idx  ' + label, args);
  await admin.unsafe(`drop index if exists mdl_plant_material_idx`);
} finally {
  await admin.end();
  await destroyTenant(tenant.client);
  await closeDb();
}
