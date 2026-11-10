-- SCR-072 / R-120 (stage 3): tenant isolation for reversal registers.
--
-- Reversal links and reversal reasons are retained evidence: insert
-- and read only. No update or delete grants.
alter table public.reversal_reason enable row level security;
--> statement-breakpoint
alter table public.reversal_reason force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.reversal_reason
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.reversal_reason from public;
--> statement-breakpoint
grant select, insert on public.reversal_reason to cairn_app;
--> statement-breakpoint
alter table public.accounting_reversal_link enable row level security;
--> statement-breakpoint
alter table public.accounting_reversal_link force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.accounting_reversal_link
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.accounting_reversal_link from public;
--> statement-breakpoint
grant select, insert on public.accounting_reversal_link to cairn_app;
