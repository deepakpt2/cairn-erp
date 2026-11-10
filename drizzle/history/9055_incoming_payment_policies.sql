-- SCR-068 / R-116 (stage 2): tenant isolation for incoming payments.
--
-- Payment records are retained evidence: insert and read only.
alter table public.incoming_payment enable row level security;
--> statement-breakpoint
alter table public.incoming_payment force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.incoming_payment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.incoming_payment from public;
--> statement-breakpoint
grant select, insert on public.incoming_payment to cairn_app;
