-- SCR-048 / R-96 (stage 2): tenant isolation for the new material-type tables.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app. Both tables here.
alter table public.account_category_reference enable row level security;
--> statement-breakpoint
alter table public.account_category_reference force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.account_category_reference
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.account_category_reference from public;
--> statement-breakpoint
grant select, insert, update, delete on public.account_category_reference to cairn_app;
--> statement-breakpoint
alter table public.material_type_valuation enable row level security;
--> statement-breakpoint
alter table public.material_type_valuation force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.material_type_valuation
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.material_type_valuation from public;
--> statement-breakpoint
grant select, insert, update, delete on public.material_type_valuation to cairn_app;
