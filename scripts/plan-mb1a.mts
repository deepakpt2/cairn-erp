/**
 * SCR-136 stage 2 — MB1A (INV.GI.POST) index decision evidence.
 *
 * A goods issue writes no new table (§26.887), so the question is whether any read
 * it makes wants an index the standing keys do not already carry. The four reads:
 * the material master in its plant, the location's stock balance, the valuation, and
 * — when a line names one — the reservation item the hook withdraws from.
 *
 * Seeds 20,000 materials extended to a plant, 80,000 location balances, 20,000
 * valuations and 20,000 reservations of three items, then times each read.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb1a.mts
 */
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr136-mb1a-plan');
const client = tenant.client;

const MASTER = `select material_number, base_unit from material where client = '${client}' and material_number = 'GI-19999'`;
const STOCK = `select quantity::text from stock_quantity
  where client = '${client}' and material_number = 'GI-19999' and plant = '1000'
    and storage_location = '0003' and stock_type = 'UNRESTRICTED'`;
const VALUATION = `select price_control, standard_price::text, stock_value::text from material_valuation
  where client = '${client}' and material_number = 'GI-19999' and valuation_area = '1000'`;
const RESERVATION_ITEM = `select required_quantity::text, withdrawn_quantity::text, is_completed, movement_allowed
  from reservation_item where client = '${client}' and reservation_number = 'RSV-019999' and item_number = 20`;

const T0 = Date.now();
const lap = (l: string) => console.log(`  · ${l} ${Date.now() - T0} ms`);

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      values (${client}, '1000', 'Plan plant', 'KW', 'plan') on conflict do nothing`);
    await tx.execute(sql`
      insert into storage_location (client, plant, storage_location, name, is_active, created_by)
      select ${client}, '1000', v, 'Store ' || v, true, 'plan' from (values ('0001'), ('0002'), ('0003'), ('0004')) s(v)
      on conflict do nothing`);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'GI-' || lpad(g::text, 5, '0'), 'Issued ' || g, t.material_type, 'PC', 'plan'
      from generate_series(1, 20000) g
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t`);
    lap('materials');
    await tx.execute(sql`
      insert into material_plant (client, material_number, plant, created_by)
      select ${client}, 'GI-' || lpad(g::text, 5, '0'), '1000', 'plan' from generate_series(1, 20000) g`);
    lap('extensions');
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      select ${client}, 'GI-' || lpad(g::text, 5, '0'), '1000', s.v, 'UNRESTRICTED', 100, 'plan'
      from generate_series(1, 20000) g cross join (values ('0001'), ('0002'), ('0003'), ('0004')) s(v)`);
    lap('balances');
    await tx.execute(sql`
      insert into material_valuation (client, material_number, valuation_area, valuation_class, price_control,
                                      standard_price, moving_average_price, price_unit, currency,
                                      total_stock_quantity, stock_value, created_by)
      select ${client}, 'GI-' || lpad(g::text, 5, '0'), '1000', 'RAW_INVENTORY', 'MOVING_AVERAGE',
             1, 10, 1, 'KWD', 400, 4000, 'plan' from generate_series(1, 20000) g`);
    lap('valuations');
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, account_assignment, created_by)
      values (${client}, 'GI_ISSUE_CC', 'Issue to cost centre', 'ISSUE', 'RESERVATION', 'COST_CENTER', 'plan')
      on conflict do nothing`);
    await tx.execute(sql`
      insert into reservation_header (client, reservation_number, movement_type, base_date, cost_center, created_by)
      select ${client}, 'RSV-' || lpad(g::text, 6, '0'), 'GI_ISSUE_CC', '2026-11-20', 'CC01', 'plan'
      from generate_series(1, 20000) g`);
    await tx.execute(sql`
      insert into reservation_item (client, reservation_number, item_number, material_number, plant,
                                    required_quantity, withdrawn_quantity, unit_of_measure, created_by)
      select ${client}, 'RSV-' || lpad(g::text, 6, '0'), l * 10,
             'GI-' || lpad(((g % 20000) + 1)::text, 5, '0'), '1000', 10, 0, 'PC', 'plan'
      from generate_series(1, 20000) g cross join generate_series(1, 3) l`);
    lap('reservations');
    await tx.execute(sql`analyze material`);
    await tx.execute(sql`analyze stock_quantity`);
    await tx.execute(sql`analyze material_valuation`);
    await tx.execute(sql`analyze reservation_item`);
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

  console.log('—— the four reads, on the standing keys ——');
  await measure('material master   ', MASTER);
  await measure('location balance  ', STOCK);
  await measure('valuation         ', VALUATION);
  await measure('reservation item  ', RESERVATION_ITEM);
} finally {
  await destroyTenant(client);
  await closeDb();
}
