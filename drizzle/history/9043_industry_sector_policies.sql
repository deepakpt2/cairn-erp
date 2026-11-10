-- SCR-052 / R-100 (stage 2): tenant isolation for industry sectors.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.industry_sector enable row level security;
--> statement-breakpoint
alter table public.industry_sector force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.industry_sector
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.industry_sector from public;
--> statement-breakpoint
grant select, insert, update, delete on public.industry_sector to cairn_app;
