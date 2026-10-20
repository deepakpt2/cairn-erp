/**
 * SCR-129 stage 2 — ME2K (PROC.PO.ACCOUNTASSIGN) index decision evidence.
 *
 * Seeds 2,000 purchase orders × 3 items × 2 assignment lines (12,000 assignment
 * rows) across 200 cost centres and a year of document dates, then times the
 * report the service will issue: assignment lines joined to their item and its
 * header, filtered on a cost-centre range and a document-date range.
 *
 * The candidate is the package recommendation on (client, cost_center) with the
 * header date — measured as a cost-centre index on the assignment table, which is
 * the only part of the recommendation that can exist on one table.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-me2k.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr129-me2k-plan');
const client = tenant.client;
const ddl = postgres(process.env.MIGRATION_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });

const REPORT = (costFrom: string, costTo: string, dateFrom: string, dateTo: string) => `
  select po.order_number, i.item_number, a.line_number, a.cost_center, a.gl_account, a.distribution_percentage,
         i.quantity, i.net_value, po.document_date
  from purchase_order_assignment a
  join purchase_order_item i on i.client = a.client and i.order_number = a.order_number and i.item_number = a.item_number
  join purchase_order po on po.client = i.client and po.order_number = i.order_number
  where a.client = '${client}'
    and a.cost_center between '${costFrom}' and '${costTo}'
    and po.document_date between '${dateFrom}' and '${dateTo}'
  order by a.cost_center, po.order_number, i.item_number, a.line_number
  limit 5001`;

try {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by) values (${client}, 'QC00', 'Plant C', 'KW', 'plan')
    `);
    await tx.execute(sql`
      insert into company_code (client, company_code, name, country, currency, chart_of_accounts, created_by)
      select ${client}, '1000', 'Plan company', 'KW', 'KWD', c.chart_of_accounts, 'plan'
      from (select chart_of_accounts from chart_of_accounts where client = ${client} limit 1) c
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, created_by) values (${client}, 'O900', 'Plan org', 'plan')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by) values (${client}, 'G90', 'Plan group', 'plan')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by) values (${client}, 'V90000', 'Plan supplier', 'plan')
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order (client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
                                  company_code, currency, document_date, release_status, created_by)
      select ${client}, '49' || lpad(g::text, 8, '0'), 'STANDARD', 'V90000', 'O900', 'G90', '1000', 'KWD',
             date '2026-01-01' + (g % 365)::int, 'RELEASED', 'plan'
      from generate_series(1, 2000) g
    `);
    await tx.execute(sql`
      insert into purchase_order_item (client, order_number, item_number, item_category, account_assignment_category,
                                       short_text, quantity, unit, net_price, price_unit, net_value, plant, created_by)
      select ${client}, '49' || lpad(o::text, 8, '0'), k, 'STANDARD', 'COST_CENTER',
             'Plan item', 10, 'PC', 10, 1, 100, 'QC00', 'plan'
      from generate_series(1, 2000) o cross join generate_series(1, 3) k
    `);
    await tx.execute(sql`
      insert into purchase_order_assignment (client, order_number, item_number, line_number, gl_account, cost_center,
                                             distribution_percentage, created_by)
      select ${client}, '49' || lpad(o::text, 8, '0'), k, n, '500000',
             'CC' || lpad((((o * 7 + k * 3 + n) % 200) + 1)::text, 4, '0'),
             100, 'plan'
      from generate_series(1, 2000) o cross join generate_series(1, 3) k cross join generate_series(1, 2) n
    `);
    await tx.execute(sql`analyze purchase_order_assignment`);
    await tx.execute(sql`analyze purchase_order`);
  });

  const counts = await withTenant(client, (tx) => tx.execute(sql`select count(*)::text as n from purchase_order_assignment`)) as unknown as Array<{ n: string }>;
  console.log('counts', JSON.stringify(counts[0]));

  const measure = async (label: string, statement: string) => {
    const plan = await withTenant(client, (tx) => tx.execute(sql.raw(
      `explain (analyze, costs off, timing off) ${statement}`,
    ))) as unknown as Array<Record<string, string>>;
    const text = plan.map((r) => Object.values(r)[0]).join('\n');
    const execution = /Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? '?';
    const indexes = [...text.matchAll(/Index (?:Only )?Scan using (\w+)/g)].map((m) => m[1]).join(', ') || 'seq scan';
    console.log(`[${label}] ${execution} ms  ->  ${indexes}`);
  };

  console.log('—— standing indexes ——');
  await measure('one cost centre, 1 month  ', REPORT('CC0007', 'CC0007', '2026-01-01', '2026-01-31'));
  await measure('cost-centre quarter range', REPORT('CC0010', 'CC0049', '2026-01-01', '2026-03-31'));
  await measure('all cost centres, year  ', REPORT('CC0001', 'CC0200', '2026-01-01', '2026-12-31'));

  await ddl`create index me2k_cand on purchase_order_assignment (client, cost_center)`;
  await ddl`analyze purchase_order_assignment`;
  console.log('—— with the package cost-centre index ——');
  await measure('one cost centre, 1 month  ', REPORT('CC0007', 'CC0007', '2026-01-01', '2026-01-31'));
  await measure('cost-centre quarter range', REPORT('CC0010', 'CC0049', '2026-01-01', '2026-03-31'));
  await measure('all cost centres, year  ', REPORT('CC0001', 'CC0200', '2026-01-01', '2026-12-31'));
  await ddl`drop index me2k_cand`;
} finally {
  await ddl.end({ timeout: 5 });
  await destroyTenant(client);
  await closeDb();
}
