-- SCR-044 / R-93 (stage 2): tenant isolation for activity_rate.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.activity_rate enable row level security;
--> statement-breakpoint
alter table public.activity_rate force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.activity_rate
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.activity_rate from public;
--> statement-breakpoint
grant select, insert, update, delete on public.activity_rate to cairn_app;
--> statement-breakpoint
