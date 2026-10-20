/**
 * SCR-131 stage 2 — MB1B (INV.TRANSFER.POST) index decision evidence.
 *
 * Seeds 3,000 materials across 4 plants, 2 storage locations and 3 stock types
 * (72,000 stock rows, 12,000 plant segments, 12,000 valuation rows), then times
 * every read the transfer posting issues before it writes: the issuing stock row,
 * the material-plant extension in both plants, the storage-location F4, the
 * valuation row, and — as the shape the package's plant-level MARD.labst check
 * would need — the summing read across a whole plant.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb1b.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr131-mb1b-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const ISSUING_STOCK = `select quantity from stock_quantity
  where client = '${client}' and material_number = 'MAT-00007' and plant = 'Q500'
    and storage_location = 'SL01' and stock_type = 'UNRESTRICTED'`;
const PLANT_STOCK = `select stock_type, sum(quantity) as q from stock_quantity
  where client = '${client}' and material_number = 'MAT-00007' and plant = 'Q500' group by stock_type`;
const EXTENSION = `select mrp_type, marked_for_deletion from material_plant
  where client = '${client}' and material_number = 'MAT-00007' and plant = 'Q500'`;
const LOCATIONS = `select storage_location, name from storage_location
  where client = '${client}' and plant = 'Q500' and is_active order by storage_location`;
const VALUATION = `select price_control, standard_price, moving_average_price, total_stock_quantity, stock_value
  from material_valuation where client = '${client}' and material_number = 'MAT-00007' and valuation_area = 'Q500'`;

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, 'Q5' || lpad(g::text, 2, '0'), 'Plant ' || g, 'KW', 'plan' from generate_series(0, 3) g
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-' || lpad(g::text, 5, '0'), 'Material ' || g, t.material_type, 'PC', 'plan'
      from generate_series(1, 3000) g
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      select ${client}, 'Q5' || lpad(p::text, 2, '0'), 'SL0' || s, 'Store ' || s, true, 'plan'
      from generate_series(0, 3) p cross join generate_series(1, 2) s
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      select ${client}, 'MAT-' || lpad(m::text, 5, '0'), 'Q5' || lpad(p::text, 2, '0'), 'SL0' || s, st.type,
             ((m + p + s) % 200)::numeric, 'plan'
      from generate_series(1, 3000) m cross join generate_series(0, 3) p cross join generate_series(1, 2) s
      cross join (values ('UNRESTRICTED'), ('QUALITY'), ('BLOCKED')) as st(type)
    `);
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, mrp_type, mrp_controller, created_by)
      select ${client}, 'MAT-' || lpad(m::text, 5, '0'), 'Q5' || lpad(p::text, 2, '0'), 'REQUIREMENTS', '001', 'plan'
      from generate_series(1, 3000) m cross join generate_series(0, 3) p
    `);
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency, total_stock_quantity,
                                      stock_value, created_by)
      select ${client}, 'MAT-' || lpad(m::text, 5, '0'), 'Q5' || lpad(p::text, 2, '0'), v.valuation_class,
             'MOVING_AVERAGE', 10, 10, 1, 'KWD', 100, 1000, 'plan'
      from generate_series(1, 3000) m cross join generate_series(0, 3) p
      cross join (select valuation_class from valuation_class where client = ${client} limit 1) v
    `);
    await tx.execute(sql`analyze stock_quantity`);
    await tx.execute(sql`analyze material_plant`);
    await tx.execute(sql`analyze storage_location`);
    await tx.execute(sql`analyze material_valuation`);
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

  console.log('—— standing indexes: the five reads the posting issues ——');
  await measure('issuing stock', ISSUING_STOCK);
  await measure('plant stock  ', PLANT_STOCK);
  await measure('extension    ', EXTENSION);
  await measure('locations    ', LOCATIONS);
  await measure('valuation    ', VALUATION);

  await ddl`create index mb1b_plant_cand on stock_quantity (client, plant, material_number, stock_type)`;
  await ddl`analyze stock_quantity`;
  console.log("—— with the plant-level candidate the plant-wide MARD sum would want ——");
  await measure('issuing stock', ISSUING_STOCK);
  await measure('plant stock  ', PLANT_STOCK);
  await ddl`drop index mb1b_plant_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
