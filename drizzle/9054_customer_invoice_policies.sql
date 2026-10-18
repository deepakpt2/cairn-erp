-- SCR-067 / R-115 (stage 2): tenant isolation for customer invoices.
--
-- Posted invoices are immutable at the permission level: the
-- application role may insert and read, and may only ever update the
-- header's cancellation columns. Lines are insert-only.
alter table public.customer_invoice enable row level security;
--> statement-breakpoint
alter table public.customer_invoice force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.customer_invoice
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.customer_invoice from public;
--> statement-breakpoint
grant select, insert on public.customer_invoice to cairn_app;
--> statement-breakpoint
grant update (status, cancelled_by, changed_by, changed_at) on public.customer_invoice to cairn_app;
--> statement-breakpoint
alter table public.customer_invoice_line enable row level security;
--> statement-breakpoint
alter table public.customer_invoice_line force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.customer_invoice_line
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.customer_invoice_line from public;
--> statement-breakpoint
grant select, insert on public.customer_invoice_line to cairn_app;
