-- SCR-050 / R-98 (stage 2): tenant isolation for the object registry.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.number_range_object enable row level security;
--> statement-breakpoint
alter table public.number_range_object force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.number_range_object
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.number_range_object from public;
--> statement-breakpoint
grant select, insert, update, delete on public.number_range_object to cairn_app;
