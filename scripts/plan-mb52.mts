/**
 * SCR-127 stage 2 — MB52 (INV.STOCK.WAREHOUSE) index decision evidence.
 *
 * Seeds a throwaway tenant with 200,000 stock-master rows (5,000 materials × 10
 * plants × 4 storage locations × a share of stock types), with valuation rows at
 * plant, then times the snapshot the service will issue: the stock master joined
 * to the material description and the valuation, aggregated by material, plant
 * and storage location and pivoted on stock type, for three shapes — one
 * material, a plant range, and no material or plant range at all (the package
 * makes every range optional).
 *
 * The candidate is the package's composite index on
 * (client, plant, storage_location, material_number). This canon's primary key
 * leads with material, so the plant-first shape is the one worth measuring.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb52.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr127-mb52-plan');
const client = tenant.client;

async function seed() {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, 'Q20' || g, 'Plant ' || g, 'KW', 'plan' from generate_series(0, 9) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-' || lpad(g::text, 5, '0'), 'Material ' || g, t.material_type, 'PC', 'plan'
      from generate_series(1, 5000) g
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      select ${client}, 'Q20' || (g % 10), 'SL0' || (g / 10), 'Location ' || g, true, 'plan'
      from generate_series(0, 39) g on conflict do nothing
    `);
    // 5,000 materials × 10 plants × 4 slocs × (unrestricted + a share of quality/blocked)
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      select ${client}, 'MAT-' || lpad(m::text, 5, '0'), 'Q20' || p, 'SL0' || s,
             case when (m + p + s) % 10 = 0 then 'QUALITY'
                  when (m + p + s) % 17 = 0 then 'BLOCKED' else 'UNRESTRICTED' end,
             ((m * 7 + p * 3 + s) % 500)::numeric,
             'plan'
      from generate_series(1, 5000) m
      cross join generate_series(0, 9) p
      cross join generate_series(0, 3) s
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into valuation_class (client, valuation_class, name, allowed_material_types, created_by)
      select ${client}, 'PLAN_CLASS', 'Plan class', 'RAW,FINISHED,TRADE,SEMI', 'plan' where not exists (
        select 1 from valuation_class where client = ${client} and valuation_class = 'PLAN_CLASS')
    `);
    await tx.execute(sql`
      insert into material_valuation (
        client, material_number, valuation_area, valuation_class, price_control,
        standard_price, moving_average_price, price_unit, currency, accounting_status, created_by
      )
      select ${client}, 'MAT-' || lpad(m::text, 5, '0'), 'Q20' || p,
             'PLAN_CLASS', case when m % 2 = 0 then 'STANDARD' else 'MOVING_AVERAGE' end,
             (m % 40) + 1, (m % 30) + 2, 1, 'KWD', 'MAINTAINED', 'plan'
      from generate_series(1, 5000) m
      cross join generate_series(0, 9) p
      on conflict do nothing
    `);
    await tx.execute(sql`analyze stock_quantity`);
    await tx.execute(sql`analyze material_valuation`);
  });
}

/** The snapshot the service issues, parameterised by the selection. */
function snapshot(where: string) {
  return sql`
    select s.material_number, coalesce(mat.description, '') as description,
           s.plant, s.storage_location, coalesce(mat.base_unit, '') as base_unit,
           sum(case when s.stock_type = 'UNRESTRICTED' then s.quantity else 0 end) as unrestricted_qty,
           sum(case when s.stock_type = 'QUALITY' then s.quantity else 0 end) as quality_qty,
           sum(case when s.stock_type = 'BLOCKED' then s.quantity else 0 end) as blocked_qty,
           sum(s.quantity) as total_qty,
           max(case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end) as price,
           max(v.price_unit) as price_unit
    from stock_quantity s
    left join material mat on mat.client = s.client and mat.material_number = s.material_number
    left join material_valuation v
      on v.client = s.client and v.material_number = s.material_number and v.valuation_area = s.plant
    where s.client = ${client} ${sql.raw(where)}
    group by s.material_number, mat.description, s.plant, s.storage_location, mat.base_unit
    order by s.material_number, s.plant, s.storage_location
    limit 5001
  `;
}

const shapes: Array<[string, string]> = [
  ['narrow  one material, one plant', `and s.material_number = 'MAT-00007' and s.plant = 'Q200'`],
  ['plant   plants Q200-Q203', `and s.plant between 'Q200' and 'Q203'`],
  ['broad   no material, no plant', ``],
];

const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

async function measure(label: string) {
  const out: Record<string, string> = {};
  for (const [name, where] of shapes) {
    const plan = (await withTenant(client, (tx) => tx.execute(sql.raw(
      `explain (analyze, costs off, timing off) ${snapshotSql(where)}`,
    )))) as unknown as Array<Record<string, string>>;
    const text = plan.map((r) => Object.values(r)[0]).join('\n');
    const execution = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const indexes = [...text.matchAll(/Index (?:Only )?Scan using (\w+)/g)].map((m) => m[1]).join(', ');
    out[name] = execution;
    console.log(`[${label} ${name}] ${execution} ms  ->  ${indexes}`);
  }
  return out;
}

// postgres().unsafe builds the statement text so explain can plan it server-side.
function snapshotSql(where: string) {
  return `select s.material_number, coalesce(mat.description, '') as description,
           s.plant, s.storage_location, coalesce(mat.base_unit, '') as base_unit,
           sum(case when s.stock_type = 'UNRESTRICTED' then s.quantity else 0 end) as unrestricted_qty,
           sum(case when s.stock_type = 'QUALITY' then s.quantity else 0 end) as quality_qty,
           sum(case when s.stock_type = 'BLOCKED' then s.quantity else 0 end) as blocked_qty,
           sum(s.quantity) as total_qty,
           max(case when v.price_control = 'STANDARD' then v.standard_price else v.moving_average_price end) as price,
           max(v.price_unit) as price_unit
    from stock_quantity s
    left join material mat on mat.client = s.client and mat.material_number = s.material_number
    left join material_valuation v
      on v.client = s.client and v.material_number = s.material_number and v.valuation_area = s.plant
    where s.client = '${client}' ${where}
    group by s.material_number, mat.description, s.plant, s.storage_location, mat.base_unit
    order by s.material_number, s.plant, s.storage_location
    limit 5001`;
}

try {
  await seed();
  const counts = await withTenant(client, (tx) => tx.execute(sql`
    select (select count(*) from stock_quantity)::text as rows,
           (select count(*) from material_valuation)::text as valuations
  `)) as unknown as Array<Record<string, string>>;
  console.log('counts', JSON.stringify(counts[0]));

  void snapshot;
  console.log('—— standing indexes (primary key on client, material, plant, sloc, stock type) ——');
  await measure('standing');

  await ddl`create index mdl_ws_snapshot_idx on stock_quantity (client, plant, storage_location, material_number)`;
  await ddl`analyze stock_quantity`;
  console.log('—— with the package composite index (client, plant, storage_location, material_number) ——');
  await measure('with-idx');
  await ddl`drop index mdl_ws_snapshot_idx`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
