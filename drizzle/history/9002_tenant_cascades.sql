-- 9002_tenant_cascades.sql — hand-written (9000+). See CAIRN.md §30 / D-041.
--
-- Every tenant-scoped table carries `client`, and `client` is the tenant
-- partition. Until now that column had no foreign key on most tables: deleting a
-- tenant removed the `client` row and left every account, document, number range
-- and configuration row behind as an orphan.
--
-- This was found the hard way. Tests leaked exhausted number ranges into the next
-- run because cleanup of a test tenant deleted the tenant and nothing else, and
-- the failure surfaced as an unrelated-looking numbering error. Orphaned
-- configuration is also a real product problem, not just a test one: a tenant
-- lifecycle that leaves data behind is not a lifecycle.
--
-- The rule this migration enforces: if a table has a `client` column, that column
-- references `client` and cascades. Written as a loop rather than forty-three
-- statements so that a table added later cannot quietly miss the rule — though the
-- Drizzle schema is the real guard going forward.

-- ---------------------------------------------------------------------------
-- 1. Remove rows that are already orphaned, so the constraints can be added.
-- ---------------------------------------------------------------------------
do $$
declare
  target record;
  removed bigint;
  total_removed bigint := 0;
begin
  for target in
    select c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname <> 'client'
       and exists (
         select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'client'
            and a.attnum > 0 and not a.attisdropped)
       and not exists (
         select 1 from pg_constraint k
          where k.conrelid = c.oid and k.contype = 'f'
            and k.confrelid = 'client'::regclass)
  loop
    execute format(
      'delete from %I t where not exists (select 1 from client x where x.client = t.client)',
      target.tbl);
    get diagnostics removed = row_count;
    if removed > 0 then
      raise notice '  purged % orphaned row(s) from %', removed, target.tbl;
      total_removed := total_removed + removed;
    end if;
  end loop;
  raise notice 'tenant cascade: purged % orphaned row(s) in total', total_removed;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Add the missing foreign keys.
--
-- NOT VALID would skip the scan, but the scan is the point: it proves there is no
-- row in the table that the new constraint would reject.
-- ---------------------------------------------------------------------------
do $$
declare
  target record;
  added int := 0;
begin
  for target in
    select c.relname as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'r'
       and c.relname <> 'client'
       and exists (
         select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'client'
            and a.attnum > 0 and not a.attisdropped)
       and not exists (
         select 1 from pg_constraint k
          where k.conrelid = c.oid and k.contype = 'f'
            and k.confrelid = 'client'::regclass)
  loop
    execute format(
      'alter table %I add constraint %I foreign key (client)
         references client (client) on delete cascade',
      target.tbl,
      target.tbl || '_client_fk');
    added := added + 1;
  end loop;
  raise notice 'tenant cascade: added % foreign key(s)', added;
end $$;
