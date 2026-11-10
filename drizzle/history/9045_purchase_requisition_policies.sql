-- SCR-055 / R-103 (stage 2): tenant isolation for purchase requisitions.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client, no PUBLIC rights, DML for
-- cairn_app.
alter table public.purchase_requisition_item enable row level security;
--> statement-breakpoint
alter table public.purchase_requisition_item force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.purchase_requisition_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.purchase_requisition_item from public;
--> statement-breakpoint
grant select, insert, update, delete on public.purchase_requisition_item to cairn_app;
--> statement-breakpoint
alter table public.purchase_requisition_assignment enable row level security;
--> statement-breakpoint
alter table public.purchase_requisition_assignment force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.purchase_requisition_assignment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.purchase_requisition_assignment from public;
--> statement-breakpoint
grant select, insert, update, delete on public.purchase_requisition_assignment to cairn_app;
