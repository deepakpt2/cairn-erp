/**
 * SCR-125 stage 2 — MB51 (INV.MATERIALDOC.LIST) index decision evidence.
 *
 * Seeds a throwaway tenant with 20,000 material documents x 3 lines (60,000
 * ledger lines) over 10 plants, 50 materials and 4 storage locations, then times
 * the document list query the service will issue — lines joined to their headers,
 * the required posting-date range, ordered newest first. Three arms: no index,
 * a header posting-date index, and that plus a line plant/material index. The
 * package's single composite cannot exist as written (plant and material stand on
 * the line, the posting date on the header), which is exactly what this measures.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb51.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr125-mb51-plan');
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
      from generate_series(1, 20000) g on conflict do nothing
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
      from generate_series(1, 20000) g cross join generate_series(1, 3) k
    `);
  });
}

const cases: Array<[string, string, string, string, string, string, string]> = [
  ['narrow      material MAT-00007, all plants, 1 month', 'MAT-00007', 'MAT-00007', 'Q100', 'Q109', '2025-03-01', '2025-03-31'],
  ['plant       plants Q100-Q104, 3 months', 'MAT-00001', 'MAT-00050', 'Q100', 'Q104', '2025-01-01', '2025-03-31'],
  ['broad       all materials, all plants, 12 months', 'MAT-00001', 'MAT-00050', 'Q100', 'Q109', '2025-01-01', '2025-12-31'],
];

async function measure(tag: string, args: string[]) {
  const [mFrom, mTo, pFrom, pTo, dFrom, dTo] = args;
  await withTenant(client, async (tx) => {
    const plan = (await tx.execute(sql`
      explain (analyze, buffers, costs)
      select d.material_document_number, d.document_year, l.line_number, l.movement_type, m.direction,
             l.material_number, l.plant, l.storage_location, l.stock_type,
             l.entry_quantity::text as entry_quantity, l.entry_unit, l.base_quantity::text as base_quantity,
             l.base_unit, l.value::text as value, l.currency, l.purchase_order_number, l.purchase_order_item,
             d.posting_date::text as posting_date, d.document_date::text as document_date, d.status, d.created_by
      from material_document_line l
      join material_document d
        on d.client = l.client and d.material_document_number = l.material_document_number
      join movement_type m on m.client = l.client and m.movement_type = l.movement_type
      where l.client = ${client}
        and l.material_number between ${mFrom} and ${mTo}
        and l.plant between ${pFrom} and ${pTo}
        and d.posting_date between ${dFrom} and ${dTo}
      order by d.posting_date desc, d.material_document_number, l.line_number
      limit 501
    `)) as unknown as Array<Record<string, string>>;
    const lines = plan.map((row) => Object.values(row)[0] as string);
    const exec = (lines.find((l) => l.includes('Execution Time')) ?? '').replace('Execution Time: ', '').trim();
    const scans = lines
      .filter((l) => /Scan|Join|Limit/.test(l) && !/Workers|Buffers|Filter|Hash Cond|Sort Key|Sort Method|Rows Removed/.test(l))
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
    select (select count(*) from material_document where client = ${client}) as docs,
           (select count(*) from material_document_line where client = ${client}) as lines
  `))) as unknown as Array<Record<string, string>>;
  console.log('counts', JSON.stringify(counts[0]));

  for (const [label, ...args] of cases) await measure('no-index     ' + label, args);

  await admin.unsafe(`create index if not exists md_posting_date_idx on material_document (client, posting_date)`);
  await admin.unsafe(`analyze material_document`);
  for (const [label, ...args] of cases) await measure('+date        ' + label, args);

  await admin.unsafe(`create index if not exists mdl_plant_material_idx on material_document_line (client, plant, material_number)`);
  await admin.unsafe(`analyze material_document_line`);
  for (const [label, ...args] of cases) await measure('+line-index  ' + label, args);

  await admin.unsafe(`drop index if exists mdl_plant_material_idx`);
  await admin.unsafe(`drop index if exists md_posting_date_idx`);
} finally {
  await admin.end();
  await destroyTenant(tenant.client);
  await closeDb();
}
