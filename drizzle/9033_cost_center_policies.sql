-- SCR-041 / R-90 (stage 2): tenant isolation for cost_center.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on app.current_client, no PUBLIC rights,
-- DML for cairn_app.
alter table public.cost_center enable row level security;
--> statement-breakpoint
alter table public.cost_center force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center
  using (client = current_setting('app.current_client', true))
  with check (client = current_setting('app.current_client', true));
--> statement-breakpoint
revoke all on public.cost_center from public;
--> statement-breakpoint
grant select, insert, update, delete on public.cost_center to cairn_app;
--> statement-breakpoint
