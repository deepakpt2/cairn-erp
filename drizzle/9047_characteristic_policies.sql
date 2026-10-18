-- SCR-057 / R-105 (stage 2): tenant isolation for characteristics.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client, no PUBLIC rights, DML for
-- cairn_app.
alter table public.characteristic enable row level security;
--> statement-breakpoint
alter table public.characteristic force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.characteristic
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.characteristic from public;
--> statement-breakpoint
grant select, insert, update, delete on public.characteristic to cairn_app;
--> statement-breakpoint
alter table public.characteristic_value enable row level security;
--> statement-breakpoint
alter table public.characteristic_value force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.characteristic_value
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.characteristic_value from public;
--> statement-breakpoint
grant select, insert, update, delete on public.characteristic_value to cairn_app;
