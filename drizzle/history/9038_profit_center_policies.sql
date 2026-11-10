-- SCR-045 / R-94 (stage 2): tenant isolation for profit_center.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.profit_center enable row level security;
--> statement-breakpoint
alter table public.profit_center force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.profit_center
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.profit_center from public;
--> statement-breakpoint
grant select, insert, update, delete on public.profit_center to cairn_app;
--> statement-breakpoint
