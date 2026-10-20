/**
 * SCR-130 stage 2 — MD04 (PROD.MRP.STOCKREQ) index decision evidence.
 *
 * Seeds 3,000 materials across 4 plants with stock, open purchase requisitions
 * and purchase orders (36,000 stock rows, 16,000 requisition items, 8,000 order
 * items), then times the three reads MD04 issues for one material and one plant.
 *
 * The package recommends (client, plant, material, requirement_date) on a pegging
 * table this round declines; the date lives on each document instead, so it is
 * measured as the leading-key index each real table could take.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-md04.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr130-md04-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const STOCK = `select stock_type, sum(quantity) as q from stock_quantity
  where client = '${client}' and material_number = 'MAT-00007' and plant = 'Q500' group by stock_type`;
const PR = `select requisition_number, item_number, quantity, delivery_date from purchase_requisition_item
  where client = '${client}' and material_number = 'MAT-00007' and plant = 'Q500'
    and not marked_for_deletion order by delivery_date`;
const PO = `select i.order_number, i.item_number, i.quantity, po.document_date
  from purchase_order_item i
  join purchase_order po on po.client = i.client and po.order_number = i.order_number
  where i.client = '${client}' and i.material_number = 'MAT-00007' and i.plant = 'Q500'
  order by po.document_date, i.order_number, i.item_number`;

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
      select ${client}, 'Q5' || lpad(g::text, 2, '0'), 'SL01', 'Store', true, 'plan' from generate_series(0, 3) g
    `);
    await tx.execute(sql`
      insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
      select ${client}, 'MAT-' || lpad(m::text, 5, '0'), 'Q5' || lpad(p::text, 2, '0'), 'SL01', st.type, ((m + p) % 200)::numeric, 'plan'
      from generate_series(1, 3000) m cross join generate_series(0, 3) p
      cross join (values ('UNRESTRICTED'), ('QUALITY'), ('BLOCKED')) as st(type)
    `);
    await tx.execute(sql`insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G50', 'Plan group', 'plan') on conflict do nothing`);
    await tx.execute(sql`
      insert into purchase_requisition_item (client, requisition_number, item_number, short_text, quantity, unit,
                                             requisition_date, delivery_date, plant, purchasing_group, material_number, created_by)
      select ${client}, '44' || lpad(g::text, 8, '0'), 1 + (g % 2), 'Plan', 10, 'PC', date '2026-01-01',
             (date '2026-02-01' + (g % 300)), 'Q500', 'G50', 'MAT-' || lpad(((g % 3000) + 1)::text, 5, '0'), 'plan'
      from generate_series(1, 16000) g
    `);
    await tx.execute(sql`insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O500', 'Plan org', 'plan') on conflict do nothing`);
    await tx.execute(sql`insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V50000', 'Plan supplier', 'plan') on conflict do nothing`);
    await tx.execute(sql`
      insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
      select ${client}, '1000', 'Plan company', 'KW', 'KWD', c.chart_of_accounts, 'plan'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
                                  company_code, currency, document_date, release_status, created_by)
      select ${client}, '45' || lpad(g::text, 8, '0'), 'STANDARD', 'V50000', 'O500', 'G50', '1000', 'KWD',
             (date '2026-01-01' + (g % 300)), 'RELEASED', 'plan'
      from generate_series(1, 8000) g
    `);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, item_category, short_text, material_number,
                                       quantity, unit, net_price, price_unit, net_value, plant, created_by)
      select ${client}, '45' || lpad(g::text, 8, '0'), 1, 'STANDARD', 'Plan',
             'MAT-' || lpad(((g % 3000) + 1)::text, 5, '0'), 10, 'PC', 10, 1, 100, 'Q500', 'plan'
      from generate_series(1, 8000) g
    `);
    await tx.execute(sql`analyze stock_quantity`);
    await tx.execute(sql`analyze purchase_requisition_item`);
    await tx.execute(sql`analyze purchase_order_item`);
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

  console.log('—— standing indexes: the three MRP reads for one material and plant ——');
  await measure('stock       ', STOCK);
  await measure('requisitions', PR);
  await measure('orders      ', PO);

  await ddl`create index md04_pr_cand on purchase_requisition_item (client, plant, material_number, delivery_date)`;
  await ddl`create index md04_po_cand on purchase_order_item (client, plant, material_number)`;
  await ddl`analyze purchase_requisition_item`;
  await ddl`analyze purchase_order_item`;
  console.log('—— with the leading-key candidates on the two document tables ——');
  await measure('stock       ', STOCK);
  await measure('requisitions', PR);
  await measure('orders      ', PO);
  await ddl`drop index md04_pr_cand`;
  await ddl`drop index md04_po_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
