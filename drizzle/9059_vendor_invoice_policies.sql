-- SCR-075 / R-123 (stage 2): tenant isolation for vendor invoices.
--
-- Posted invoices are immutable at the permission level: the
-- application role may insert and read, and may only ever update
-- the header's cancellation columns. Lines are insert-only.
alter table public.vendor_invoice enable row level security;
--> statement-breakpoint
alter table public.vendor_invoice force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.vendor_invoice
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.vendor_invoice from public;
--> statement-breakpoint
grant select, insert on public.vendor_invoice to cairn_app;
--> statement-breakpoint
grant update (status, cancelled_by, changed_by, changed_at) on public.vendor_invoice to cairn_app;
--> statement-breakpoint
alter table public.vendor_invoice_line enable row level security;
--> statement-breakpoint
alter table public.vendor_invoice_line force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.vendor_invoice_line
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.vendor_invoice_line from public;
--> statement-breakpoint
grant select, insert on public.vendor_invoice_line to cairn_app;
