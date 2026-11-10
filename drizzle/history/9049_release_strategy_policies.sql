-- SCR-059 / R-107 (stage 2): tenant isolation for release strategies.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client, no PUBLIC rights, DML for
-- cairn_app, applied to all five tables.
alter table public.release_group enable row level security;
--> statement-breakpoint
alter table public.release_group force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.release_group
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.release_group from public;
--> statement-breakpoint
grant select, insert, update, delete on public.release_group to cairn_app;
--> statement-breakpoint
alter table public.release_code enable row level security;
--> statement-breakpoint
alter table public.release_code force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.release_code
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.release_code from public;
--> statement-breakpoint
grant select, insert, update, delete on public.release_code to cairn_app;
--> statement-breakpoint
alter table public.release_strategy enable row level security;
--> statement-breakpoint
alter table public.release_strategy force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.release_strategy
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.release_strategy from public;
--> statement-breakpoint
grant select, insert, update, delete on public.release_strategy to cairn_app;
--> statement-breakpoint
alter table public.release_strategy_criterion enable row level security;
--> statement-breakpoint
alter table public.release_strategy_criterion force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.release_strategy_criterion
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.release_strategy_criterion from public;
--> statement-breakpoint
grant select, insert, update, delete on public.release_strategy_criterion to cairn_app;
--> statement-breakpoint
alter table public.release_strategy_step enable row level security;
--> statement-breakpoint
alter table public.release_strategy_step force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.release_strategy_step
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.release_strategy_step from public;
--> statement-breakpoint
grant select, insert, update, delete on public.release_strategy_step to cairn_app;
