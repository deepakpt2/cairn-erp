-- SCR-056 / R-104 (stage 2): tenant isolation for purchase orders.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client, no PUBLIC rights, DML for
-- cairn_app.
alter table public.purchase_order enable row level security;
--> statement-breakpoint
alter table public.purchase_order force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.purchase_order
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.purchase_order from public;
--> statement-breakpoint
grant select, insert, update, delete on public.purchase_order to cairn_app;
--> statement-breakpoint
alter table public.purchase_order_item enable row level security;
--> statement-breakpoint
alter table public.purchase_order_item force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.purchase_order_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.purchase_order_item from public;
--> statement-breakpoint
grant select, insert, update, delete on public.purchase_order_item to cairn_app;
--> statement-breakpoint
alter table public.purchase_order_schedule_line enable row level security;
--> statement-breakpoint
alter table public.purchase_order_schedule_line force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.purchase_order_schedule_line
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.purchase_order_schedule_line from public;
--> statement-breakpoint
grant select, insert, update, delete on public.purchase_order_schedule_line to cairn_app;
--> statement-breakpoint
alter table public.purchase_order_assignment enable row level security;
--> statement-breakpoint
alter table public.purchase_order_assignment force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.purchase_order_assignment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.purchase_order_assignment from public;
--> statement-breakpoint
grant select, insert, update, delete on public.purchase_order_assignment to cairn_app;
