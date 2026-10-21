import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { withTenant } from '../src/platform/db/client';

/**
 * SCR-148 stage 2 — the index decision, pinned so a later tidy cannot drop it quietly.
 *
 * The measurement is in migration 9090. This only proves the index that plan selected is the
 * one that stands, and that it is not a second copy of the planned-date index.
 */
describe('SCR-148 difference-list index', () => {
  it('keeps the plant-and-year index the list plan selects', async () => {
    const rows = await withTenant('0100', (tx) => tx.execute(sql`
      select indexname, indexdef
        from pg_indexes
       where schemaname = 'public'
         and tablename = 'physical_inventory_document'
         and indexname in (
           'physical_inventory_document_plant_year_idx',
           'physical_inventory_document_plant_idx'
         )
       order by indexname
    `)) as unknown as Array<{ indexname: string; indexdef: string }>;

    expect(rows.map((r) => r.indexname)).toEqual([
      'physical_inventory_document_plant_idx',
      'physical_inventory_document_plant_year_idx',
    ]);
    const year = rows[1].indexdef;
    expect(year).toContain('(client, plant, fiscal_year, inventory_document_number)');
    expect(year).not.toContain('planned_count_date');
    expect(rows[0].indexdef).toContain('planned_count_date');
  });
});
