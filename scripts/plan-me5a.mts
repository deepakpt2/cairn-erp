/**
 * SCR-123 stage 2 — ME5A index decision evidence.
 *
 * Seeds a throwaway tenant (60,000 requisition items over 10 plants x 8 groups x 24
 * months, 20,000 converting purchase-order items), then times the list query the
 * PROC.REQ.LIST service will issue, with and without the candidate composite index
 * (client, plant, purchasing_group, requisition_date). The tenant and the trial
 * index are destroyed at the end. Result recorded in CAIRN-6 §26.841: no migration.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-me5a.mts
 */
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('me5a-plan');
const client = tenant.client;
try {
  await withTenant(client, async (tx) => {
    // Masters the foreign keys need.
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, (1000 + g)::text, 'Plant ' || g, 'US', 'plan'
      from generate_series(0, 9) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      select ${client}, lpad((1 + g)::text, 3, '0'), 'Group ' || g, 'plan'
      from generate_series(0, 7) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by)
      values (${client}, 'V10000', 'Plan supplier', 'plan') on conflict do nothing
    `);
    // 60,000 requisition items across 10 plants, 8 purchasing groups, 24 months.
    await tx.execute(sql`
      insert into purchase_requisition_item (
        client, requisition_number, item_number, document_type, item_category,
        material_number, short_text, quantity, unit, requisition_date, delivery_date,
        plant, purchasing_group, marked_for_deletion, creation_source, created_by
      )
      select ${client}, lpad((100000 + g)::text, 10, '0'), 10, 'STANDARD', 'STANDARD',
             null, 'Synthetic demand', (1 + (g % 50))::numeric, 'PC',
             (date '2024-01-01' + ((g % 720))::int),
             (date '2024-02-01' + ((g % 720))::int),
             (1000 + (g % 10))::text, lpad((1 + (g % 8))::text, 3, '0'),
             false, 'MANUAL', 'plan'
      from generate_series(1, 60000) g
      on conflict do nothing
    `);
    // 20,000 purchase-order items converting some of them.
    await tx.execute(sql`
      insert into purchase_order (
        client, order_number, document_type, supplier_number, purchasing_org,
        purchasing_group, company_code, currency, document_date, release_status, created_by
      )
      select ${client}, 'PO' || lpad(g::text, 8, '0'), 'STANDARD', 'V10000', '1000',
             '001', '1000', 'USD', date '2025-01-01', 'RELEASED', 'plan'
      from generate_series(1, 20000) g
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item (
        client, order_number, item_number, item_category, material_number, short_text,
        quantity, unit, net_price, price_unit, net_value, plant, requisition_number,
        requisition_item, marked_for_deletion, created_by
      )
      select ${client}, 'PO' || lpad(g::text, 8, '0'), 10, 'STANDARD', null, 'Converted demand',
             1::numeric, 'PC', 10::numeric, 1, 10::numeric, (1000 + (g % 10))::text,
             lpad((100000 + g)::text, 10, '0'), 10, false, 'plan'
      from generate_series(1, 20000) g
      on conflict do nothing
    `);
  });

  // Statistics visible in a separate session/tx, as the service would see them.
  const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!migrationUrl) throw new Error('No migration URL configured');
  const admin = postgres(migrationUrl, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(`analyze purchase_requisition_item`);
    await admin.unsafe(`analyze purchase_order_item`);

    await withTenant(client, async (tx) => {
      const counts = (await tx.execute(sql`
        select (select count(*) from purchase_requisition_item where client = ${client}) as req,
               (select count(*) from purchase_order_item where client = ${client}) as poi,
               (select count(*) from purchase_requisition_item where client = ${client}
                  and requisition_date between '2025-01-01' and '2025-12-31') as in_range
      `)) as unknown as Array<Record<string, string>>;
      console.log('counts', JSON.stringify(counts[0]));
    });

    const cases: Array<[string, string, string, string, string, string, string]> = [
      ['selective  plant 1003, groups 001-002, 3 months', '1003', '1003', '001', '002', '2025-04-01', '2025-06-30'],
      ['medium     plants 1002-1005, groups 001-004, 6 months', '1002', '1005', '001', '004', '2025-01-01', '2025-06-30'],
      ['broad      plants 1000-1009, groups 001-008, 12 months', '1000', '1009', '001', '008', '2025-01-01', '2025-12-31'],
    ];

    async function measure(tag: string, args: string[]) {
      const [pFrom, pTo, gFrom, gTo, dFrom, dTo] = args;
      await withTenant(client, async (tx) => {
        const plan = (await tx.execute(sql`
          explain (analyze, buffers, costs)
          select r.requisition_number, r.item_number, r.plant, r.purchasing_group, r.requisition_date,
                 coalesce(po.ordered, 0) as ordered
          from purchase_requisition_item r
          left join (
            select requisition_number, requisition_item, sum(quantity) as ordered
            from purchase_order_item
            where client = ${client} and not marked_for_deletion and requisition_number is not null
            group by requisition_number, requisition_item
          ) po on po.requisition_number = r.requisition_number and po.requisition_item = r.item_number
          where r.client = ${client}
            and r.plant between ${pFrom} and ${pTo}
            and r.purchasing_group between ${gFrom} and ${gTo}
            and r.requisition_date between ${dFrom} and ${dTo}
          order by r.requisition_date desc, r.requisition_number, r.item_number
          limit 500
        `)) as unknown as Array<Record<string, string>>;
        const lines = plan.map((row) => Object.values(row)[0] as string);
        const exec = (lines.find((l) => l.includes('Execution Time')) ?? '').replace('Execution Time: ', '').trim();
        const scans = lines
          .filter((l) => /Scan|Join|Limit/.test(l) && !/Workers|Buffers|Filter|Hash Cond|Sort Key|Sort Method|Rows Removed/.test(l))
          .map((l) => l.trim().replace(/\s*\(cost=.*$/, ''))
          .slice(0, 5);
        console.log(`[${tag}] ${exec}`);
        for (const scan of scans) console.log(`    ${scan}`);
      });
    }

    for (const [label, ...args] of cases) await measure('no-index   ' + label, args);

    await admin.unsafe(`create index if not exists pr_item_me5a_query_idx on purchase_requisition_item (client, plant, purchasing_group, requisition_date)`);
    await admin.unsafe(`analyze purchase_requisition_item`);
    for (const [label, ...args] of cases) await measure('with-index ' + label, args);
    await admin.unsafe(`drop index if exists pr_item_me5a_query_idx`);
  } finally {
    await admin.end();
    await destroyTenant(tenant.client);
    await closeDb();
  }
} catch (error) {
  await destroyTenant(tenant.client);
  await closeDb();
  throw error;
}
