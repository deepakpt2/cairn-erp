/**
 * SCR-128 stage 2 — MMBE (INV.STOCK.VIEW) index decision evidence.
 *
 * Seeds a throwaway tenant with one material held in 200 storage locations
 * across 10 plants (2,000 stock rows), then times the tree query MMBE issues:
 * the stock master for one material, grouped by plant, storage location and
 * stock type, ordered for the three-level roll-up.
 *
 * The candidate is the package's composite index on
 * (client, material_number, plant, storage_location) — which is a strict prefix
 * of `stock_quantity_pkey` (client, material, plant, storage_location,
 * stock_type), so the expectation is that it is redundant by construction.
 * Measured rather than assumed, as in the last two rounds.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mmbe.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr128-mmbe-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const TREE = (material: string, plant: string) => `select s.plant, s.storage_location, s.stock_type, sum(s.quantity) as qty
  from stock_quantity s
  where s.client = '${client}' and s.material_number = '${material}' and s.plant between '${plant}' and '${plant}'
  group by s.plant, s.storage_location, s.stock_type
  order by s.plant, s.storage_location, s.stock_type
  limit 5001`;

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, 'Q40' || g, 'Plant ' || g, 'KW', 'plan' from generate_series(0, 9) g
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'M-' || lpad(g::text, 5, '0'), 'Material ' || g, t.material_type, 'PC', 'plan'
      from generate_series(1, 40) g
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    // 40 materials × 10 plants × 5 locations × 3 stock types = 6,000 rows; one material
    // holds 200 locations across the ten plants, the shape MMBE is aimed at.
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      select ${client}, 'M-' || lpad(m::text, 5, '0'), 'Q40' || p, 'SL' || lpad(s::text, 3, '0'),
             st.type, ((m * 7 + p * 3 + s) % 500)::numeric, 'plan'
      from generate_series(1, 40) m
      cross join generate_series(0, 9) p
      cross join generate_series(0, 4) s
      cross join (values ('UNRESTRICTED'), ('QUALITY'), ('BLOCKED')) as st(type)
    `);
    await tx.execute(sql`analyze stock_quantity`);
  });

  const count = await withTenant(client, (tx) => tx.execute(sql`select count(*)::text as n from stock_quantity`)) as unknown as Array<{ n: string }>;
  console.log('counts', JSON.stringify(count[0]));

  const measure = async (label: string, statement: string) => {
    const plan = await withTenant(client, (tx) => tx.execute(sql.raw(
      `explain (analyze, costs off, timing off) ${statement}`,
    ))) as unknown as Array<Record<string, string>>;
    const text = plan.map((r) => Object.values(r)[0]).join('\n');
    const execution = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const indexes = [...text.matchAll(/Index (?:Only )?Scan using (\w+)/g)].map((m) => m[1]).join(', ') || 'seq scan';
    console.log(`[${label}] ${execution} ms  ->  ${indexes}`);
  };

  console.log('—— standing indexes (primary key client, material, plant, sloc, stock type) ——');
  await measure('one material, one plant  ', TREE('M-00007', 'Q400'));
  await measure('one material, all plants', TREE('M-00007', 'Q400'));

  await ddl`create index mmbe_cand on stock_quantity (client, material_number, plant, storage_location)`;
  await ddl`analyze stock_quantity`;
  console.log('—— with the package composite index (client, material, plant, storage_location) ——');
  await measure('one material, one plant  ', TREE('M-00007', 'Q400'));
  await measure('one material, all plants', TREE('M-00007', 'Q400'));
  await ddl`drop index mmbe_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
