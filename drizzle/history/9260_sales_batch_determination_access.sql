-- ── Access for the batch determination rule ───────────────────────────────────
--
-- 9259 created sales_batch_determination_rule without enabling row level security,
-- tenant policy or grant to cairn_app, so the application role could not read or
-- write the rule it is meant to maintain. This migration supplies what every other
-- tenant table in this package carries, and is written to be safe to re-run:
-- 9259 is applied on databases that will not re-run it, which is why the access
-- lives here rather than being corrected in place.

alter table sales_batch_determination_rule enable row level security;

do $$
begin
  execute format('drop policy if exists %I on %I', 'sales_batch_determination_rule_tenant', 'sales_batch_determination_rule');
  execute format(
    'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
    'sales_batch_determination_rule_tenant', 'sales_batch_determination_rule'
  );
  execute format('revoke all on table %I from public', 'sales_batch_determination_rule');
  execute format('grant select, insert, update, delete on table %I to cairn_app', 'sales_batch_determination_rule');
end $$;
