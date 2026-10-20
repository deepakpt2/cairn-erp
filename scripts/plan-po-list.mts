/**
 * SCR-124 stage 2 — ME2L (PROC.PO.LIST) index decision evidence.
 *
 * Seeds a throwaway tenant (8,000 purchase orders x 5 items = 40,000 order items,
 * 20,000 goods-receipt lines and 12,000 supplier-invoice items citing them), then
 * times the purchase order list query the service will issue under the three
 * selection shapes, with and without the package's recommended composite index on
 * the header (client, supplier_number, purchasing_org, document_date). The tenant
 * and the trial index are destroyed at the end.
 *
 *   set -a; . ./.env.local; set +a; npx tsx scripts/plan-po-list.mts
 */
import postgres from 'postgres';
import { sql } from 'drizzle-orm';

import { withTenant, closeDb } from '../src/platform/db/client';
import { createTenant, destroyTenant } from '../tests/helpers';

const tenant = await createTenant('scr124-po-list-plan');
const client = tenant.client;

async function seed() {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into business_partner (client, partner_number, name, created_by)
      select ${client}, 'V' || lpad(g::text, 5, '0'), 'Supplier ' || g, 'plan'
      from generate_series(1, 200) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_org (client, purchasing_org, name, created_by)
      select ${client}, 'O10' || g, 'Org ' || g, 'plan' from generate_series(0, 3) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchasing_group (client, purchasing_group, name, created_by)
      select ${client}, 'G0' || (g + 1), 'Group ' || g, 'plan' from generate_series(0, 7) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into plant (client, plant, name, country, created_by)
      select ${client}, 'P10' || g, 'Plant ' || g, 'KW', 'plan' from generate_series(0, 4) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material (client, material_number, description, material_type, base_unit, created_by)
      select ${client}, 'M0000001', 'Plan material', t.material_type, 'PC', 'plan'
      from (select material_type from material_type where client = ${client} order by material_type limit 1) t
      on conflict do nothing
    `);
    await tx.execute(sql`
      insert into movement_type (client, movement_type, description, direction, reference_category, created_by) values
        (${client}, 'GOODS_RECEIPT_PO', 'Goods receipt for purchase order', 'RECEIPT', 'PURCHASE_ORDER', 'plan'),
        (${client}, 'RECEIPT_REVERSAL', 'Reversal of a goods receipt', 'REVERSAL', 'MATERIAL_DOCUMENT', 'plan')
      on conflict do nothing
    `);

    // 8,000 headers x 5 items.
    await tx.execute(sql`
      insert into purchase_order (
        client, order_number, document_type, supplier_number, purchasing_org, purchasing_group,
        company_code, currency, document_date, release_status, created_by
      )
      select ${client}, '45' || lpad(g::text, 8, '0'),
             'STANDARD', 'V' || lpad(((g % 200) + 1)::text, 5, '0'),
             'O10' || (g % 4), 'G0' || ((g % 8) + 1), '1000', 'USD',
             (date '2025-01-01' + (g % 365)::int), 'RELEASED', 'plan'
      from generate_series(1, 8000) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into purchase_order_item (
        client, order_number, item_number, item_category, material_number, short_text,
        quantity, unit, net_price, price_unit, net_value, plant, marked_for_deletion, created_by
      )
      select ${client}, '45' || lpad(g::text, 8, '0'), k * 10, 'STANDARD', 'M0000001', 'Plan demand',
             5::numeric, 'PC', 10::numeric, 1, 50::numeric, 'P10' || (g % 5), false, 'plan'
      from generate_series(1, 8000) g cross join generate_series(1, 5) k
    `);

    // 20,000 goods-receipt documents, one line each, citing the first 20,000 order lines.
    await tx.execute(sql`
      insert into material_document (
        client, material_document_number, document_year, document_date, posting_date, status, created_by
      )
      select ${client}, '50' || lpad(g::text, 8, '0'), 2025,
             (date '2025-02-01' + (g % 300)::int), (date '2025-02-01' + (g % 300)::int), 'POSTED', 'plan'
      from generate_series(1, 20000) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into material_document_line (
        client, material_document_number, line_number, movement_type, material_number, plant,
        stock_type, entry_quantity, entry_unit, base_quantity, base_unit,
        unit_price, price_unit, value, purchase_order_number, purchase_order_item, created_by
      )
      select ${client}, '50' || lpad(g::text, 8, '0'), 1, 'GOODS_RECEIPT_PO', 'M0000001', 'P100',
             'UNRESTRICTED', 2::numeric, 'PC', 2::numeric, 'PC', 10::numeric, 1, 20::numeric,
             '45' || lpad((((g - 1) % 8000) + 1)::text, 8, '0'), 10, 'plan'
      from generate_series(1, 20000) g
    `);

    // 12,000 supplier invoices, one line each.
    await tx.execute(sql`
      insert into supplier_invoice (
        client, invoice_number, fiscal_year, category, supplier_number, company_code,
        purchase_order_number, invoice_date, posting_date, supplier_reference, currency,
        gross_amount, tax_amount, status, created_by
      )
      select ${client}, 'SI' || lpad(g::text, 8, '0'), 2025, 'INVOICE',
             'V' || lpad((((g - 1) % 200) + 1)::text, 5, '0'), '1000',
             '45' || lpad((((g - 1) % 8000) + 1)::text, 8, '0'),
             (date '2025-03-01' + (g % 280)::int), (date '2025-03-01' + (g % 280)::int),
             'REF' || g, 'USD', 20::numeric, 0::numeric, 'POSTED', 'plan'
      from generate_series(1, 12000) g on conflict do nothing
    `);
    await tx.execute(sql`
      insert into supplier_invoice_item (
        client, invoice_number, line_number, purchase_order_number, purchase_order_item,
        quantity, unit, net_amount, expected_amount, variance_amount, tax_amount, created_by
      )
      select ${client}, 'SI' || lpad(g::text, 8, '0'), 1,
             '45' || lpad((((g - 1) % 8000) + 1)::text, 8, '0'), 10,
             2::numeric, 'PC', 20::numeric, 20::numeric, 0::numeric, 0::numeric, 'plan'
      from generate_series(1, 12000) g
    `);
  });
}

const cases: Array<[string, string, string, string, string, string, string]> = [
  ['selective  vendor V00007, org O100, 3 months', 'V00007', 'V00007', 'O100', 'O100', '2025-01-01', '2025-03-31'],
  ['medium     vendors V00010-V00060, all orgs, 6 months', 'V00010', 'V00060', 'O100', 'O103', '2025-01-01', '2025-06-30'],
  ['broad      all vendors, all orgs, 12 months', 'V00001', 'V00200', 'O100', 'O103', '2025-01-01', '2025-12-31'],
];

async function measure(tag: string, args: string[]) {
  const [vFrom, vTo, oFrom, oTo, dFrom, dTo] = args;
  await withTenant(client, async (tx) => {
    const plan = (await tx.execute(sql`
      explain (analyze, buffers, costs)
      select po.order_number, i.item_number, po.supplier_number, po.purchasing_org, po.purchasing_group,
             po.company_code, po.document_date::text as document_date, i.material_number, i.plant,
             i.quantity::text as quantity, i.net_value::text as net_value, po.currency,
             po.release_status, i.marked_for_deletion,
             coalesce(gr.delivered, 0)::text as delivered, coalesce(ir.invoiced, 0)::text as invoiced
      from purchase_order_item i
      join purchase_order po on po.client = i.client and po.order_number = i.order_number
      left join (
        select l.purchase_order_number, l.purchase_order_item,
               sum(case when m.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as delivered
        from material_document_line l
        join material_document d
          on d.client = l.client and d.material_document_number = l.material_document_number and d.status = 'POSTED'
        join movement_type m on m.client = l.client and m.movement_type = l.movement_type
        where l.client = ${client} and l.purchase_order_number is not null
        group by l.purchase_order_number, l.purchase_order_item
      ) gr on gr.purchase_order_number = i.order_number and gr.purchase_order_item = i.item_number
      left join (
        select si.purchase_order_number, si.purchase_order_item, sum(si.quantity) as invoiced
        from supplier_invoice_item si
        join supplier_invoice s
          on s.client = si.client and s.invoice_number = si.invoice_number and s.status = 'POSTED'
        where si.client = ${client} and si.purchase_order_number is not null
        group by si.purchase_order_number, si.purchase_order_item
      ) ir on ir.purchase_order_number = i.order_number and ir.purchase_order_item = i.item_number
      where i.client = ${client}
        and po.supplier_number between ${vFrom} and ${vTo}
        and po.purchasing_org between ${oFrom} and ${oTo}
        and po.document_date between ${dFrom} and ${dTo}
      order by po.supplier_number, po.document_date desc, po.order_number, i.item_number
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
  await admin.unsafe(`analyze purchase_order`);
  await admin.unsafe(`analyze purchase_order_item`);
  await admin.unsafe(`analyze material_document_line`);
  await admin.unsafe(`analyze supplier_invoice_item`);

  const counts = (await withTenant(client, async (tx) => tx.execute(sql`
    select (select count(*) from purchase_order where client = ${client}) as po,
           (select count(*) from purchase_order_item where client = ${client}) as poi,
           (select count(*) from material_document_line where client = ${client}) as gr,
           (select count(*) from supplier_invoice_item where client = ${client}) as ir
  `))) as unknown as Array<Record<string, string>>;
  console.log('counts', JSON.stringify(counts[0]));

  for (const [label, ...args] of cases) await measure('no-index   ' + label, args);

  await admin.unsafe(`create index if not exists po_suite_report_idx on purchase_order (client, supplier_number, purchasing_org, document_date)`);
  await admin.unsafe(`analyze purchase_order`);
  for (const [label, ...args] of cases) await measure('with-index ' + label, args);
  await admin.unsafe(`drop index if exists po_suite_report_idx`);
} finally {
  await admin.end();
  await destroyTenant(tenant.client);
  await closeDb();
}
