/**
 * SCR-133 stage 2 — MB21 (INV.RESERVATION.CREATE) index decision evidence.
 *
 * Seeds 20,000 reservations of three items each over 3,000 materials and 4 plants
 * (60,000 items), then times the two reads a reservation is read by: the screen's
 * read of one reservation's items, and MD04's read of one material in one plant
 * — the demand read the list makes on every execution.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-mb21.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr133-mb21-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const BY_RESERVATION = `select item_number, material_number, plant, required_quantity::text, withdrawn_quantity::text
  from reservation_item where client = '${client}' and reservation_number = 'RSV-010000' order by item_number`;
const FOR_MD04 = `select i.reservation_number, i.item_number, i.required_quantity::text, i.withdrawn_quantity::text, h.base_date
  from reservation_item i
  join reservation_header h on h.client = i.client and h.reservation_number = i.reservation_number
  where i.client = '${client}' and i.plant = 'Q700' and i.material_number = 'MAT-00007' and not i.is_completed
  order by base_date, reservation_number, item_number`;

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, 'Q7' || lpad(g::text, 2, '0'), 'Plant ' || g, 'KW', 'plan' from generate_series(0, 3) g
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'MAT-' || lpad(g::text, 5, '0'), 'Material ' || g, t.material_type, 'PC', 'plan'
      from generate_series(1, 3000) g
      cross join (select material_type from material_type where client = ${client} order by material_type limit 1) t
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, account_assignment, created_by)
      values (${client}, 'RESERV_ISSUE_CC', 'Issue to cost centre', 'ISSUE', 'RESERVATION', 'COST_CENTER', 'plan')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into reservation_header (client, reservation_number, movement_type, base_date, cost_center, created_by)
      select ${client}, 'RSV-' || lpad(g::text, 6, '0'), 'RESERV_ISSUE_CC',
             (date '2026-10-01' + (g % 120))::text, 'CC01', 'plan'
      from generate_series(1, 20000) g
    `);
    await tx.execute(sql`
      insert into reservation_item (client, reservation_number, item_number, material_number, plant,
                                    required_quantity, withdrawn_quantity, unit_of_measure, created_by)
      select ${client}, 'RSV-' || lpad(g::text, 6, '0'), l,
             'MAT-' || lpad(((g % 3000) + 1)::text, 5, '0'),
             'Q7' || lpad(((g + l) % 4)::text, 2, '0'),
             10, 0, 'PC', 'plan'
      from generate_series(1, 20000) g cross join generate_series(1, 3) l
    `);
    await tx.execute(sql`analyze reservation_item`);
    await tx.execute(sql`analyze reservation_header`);
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

  console.log('—— standing indexes: the two reads ——');
  await measure('by reservation', BY_RESERVATION);
  await measure('md04 demand   ', FOR_MD04);

  await ddl`create index mb21_demand_cand on reservation_item (client, plant, material_number)`;
  await ddl`analyze reservation_item`;
  console.log('—— with a candidate on the demand read ——');
  await measure('by reservation', BY_RESERVATION);
  await measure('md04 demand   ', FOR_MD04);
  await ddl`drop index mb21_demand_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
