-- SCR-063 / R-111 (stage 2): tenant isolation for the payment run.
alter table public.payment_run enable row level security;
--> statement-breakpoint
alter table public.payment_run force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.payment_run
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.payment_run from public;
--> statement-breakpoint
grant select, insert, update, delete on public.payment_run to cairn_app;
--> statement-breakpoint
alter table public.payment_run_company enable row level security;
--> statement-breakpoint
alter table public.payment_run_company force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.payment_run_company
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.payment_run_company from public;
--> statement-breakpoint
grant select, insert, update, delete on public.payment_run_company to cairn_app;
--> statement-breakpoint
alter table public.payment_run_method enable row level security;
--> statement-breakpoint
alter table public.payment_run_method force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.payment_run_method
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.payment_run_method from public;
--> statement-breakpoint
grant select, insert, update, delete on public.payment_run_method to cairn_app;
--> statement-breakpoint
alter table public.payment_proposal_item enable row level security;
--> statement-breakpoint
alter table public.payment_proposal_item force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.payment_proposal_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.payment_proposal_item from public;
--> statement-breakpoint
grant select, insert, update, delete on public.payment_proposal_item to cairn_app;
--> statement-breakpoint
alter table public.payment_document enable row level security;
--> statement-breakpoint
alter table public.payment_document force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.payment_document
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.payment_document from public;
--> statement-breakpoint
grant select, insert on public.payment_document to cairn_app;
