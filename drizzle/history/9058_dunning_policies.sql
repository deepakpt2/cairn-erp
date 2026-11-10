-- SCR-074 / R-122 (stage 2): tenant isolation for the dunning registers.
--
-- Runs are maintained before finalization, so the application role
-- may update them; nothing is ever deleted through the application.
alter table public.dunning_run enable row level security;
--> statement-breakpoint
alter table public.dunning_run force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.dunning_run
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.dunning_run from public;
--> statement-breakpoint
grant select, insert, update on public.dunning_run to cairn_app;
--> statement-breakpoint
alter table public.dunning_run_company enable row level security;
--> statement-breakpoint
alter table public.dunning_run_company force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.dunning_run_company
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.dunning_run_company from public;
--> statement-breakpoint
grant select, insert, update on public.dunning_run_company to cairn_app;
--> statement-breakpoint
alter table public.dunning_run_account enable row level security;
--> statement-breakpoint
alter table public.dunning_run_account force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.dunning_run_account
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.dunning_run_account from public;
--> statement-breakpoint
grant select, insert, update on public.dunning_run_account to cairn_app;
--> statement-breakpoint
alter table public.dunning_run_item enable row level security;
--> statement-breakpoint
alter table public.dunning_run_item force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.dunning_run_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.dunning_run_item from public;
--> statement-breakpoint
grant select, insert, update on public.dunning_run_item to cairn_app;
--> statement-breakpoint
alter table public.dunning_notice enable row level security;
--> statement-breakpoint
alter table public.dunning_notice force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.dunning_notice
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.dunning_notice from public;
--> statement-breakpoint
grant select, insert on public.dunning_notice to cairn_app;
