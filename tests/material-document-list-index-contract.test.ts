/**
 * SCR-125 / MB51 stage 2 — the one index this round adds, and why.
 *
 * The list requires a posting-date range and reads newest first, so the walk
 * from the header date index is the plan the service depends on. The line-side
 * material index already stands; no second line index is added.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync('drizzle/9065_material_document_posting_date.sql', 'utf8');
const schema = readFileSync('src/modules/inventory/schema.ts', 'utf8');

describe('SCR-125 stage 2: the material document date path stands', () => {
  it('adds exactly one index, on the header posting date, tenant first', () => {
    expect(migration).toContain('create index if not exists md_posting_date_idx');
    expect(migration).toContain('on public.material_document (client, posting_date)');
    expect(migration.match(/create index/gi)).toHaveLength(1);
    expect(migration).not.toMatch(/create table|alter table|drop column/i);
  });

  it('relies on the line material index that already stands', () => {
    expect(schema).toContain("index('material_document_line_material_idx')");
    expect(migration).not.toContain('material_document_line (client, plant, material_number)');
  });
});
