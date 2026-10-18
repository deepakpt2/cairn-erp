-- SCR-062 / R-110 (stage 2): tenant isolation for invoice verification.
--
-- Posted invoices are immutable at the permission level: the
-- application role may insert and read, and may only ever update the
-- header's cancellation columns. Items are insert-only.
alter table public.supplier_invoice enable row level security;
--> statement-breakpoint
alter table public.supplier_invoice force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.supplier_invoice
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.supplier_invoice from public;
--> statement-breakpoint
grant select, insert on public.supplier_invoice to cairn_app;
--> statement-breakpoint
grant update (status, cancelled_by, changed_by, changed_at) on public.supplier_invoice to cairn_app;
--> statement-breakpoint
alter table public.supplier_invoice_item enable row level security;
--> statement-breakpoint
alter table public.supplier_invoice_item force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.supplier_invoice_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.supplier_invoice_item from public;
--> statement-breakpoint
grant select, insert on public.supplier_invoice_item to cairn_app;
