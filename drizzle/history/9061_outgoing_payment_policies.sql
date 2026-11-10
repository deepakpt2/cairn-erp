-- SCR-078 / R-126 (stage 2): tenant isolation for the outgoing payment record.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.outgoing_payment enable row level security;
--> statement-breakpoint
alter table public.outgoing_payment force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.outgoing_payment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.outgoing_payment from public;
--> statement-breakpoint
grant select, insert, update, delete on public.outgoing_payment to cairn_app;
