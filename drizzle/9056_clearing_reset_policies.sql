-- SCR-071 / R-119 (stage 2): tenant isolation for clearing resets.
--
-- Reset records are retained evidence: insert and read only.
alter table public.clearing_reset enable row level security;
--> statement-breakpoint
alter table public.clearing_reset force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.clearing_reset
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.clearing_reset from public;
--> statement-breakpoint
grant select, insert on public.clearing_reset to cairn_app;
