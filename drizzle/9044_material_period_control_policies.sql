-- SCR-054 / R-102 (stage 2): tenant isolation for material period control.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.material_period_control enable row level security;
--> statement-breakpoint
alter table public.material_period_control force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.material_period_control
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.material_period_control from public;
--> statement-breakpoint
grant select, insert, update, delete on public.material_period_control to cairn_app;
