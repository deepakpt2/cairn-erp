-- SCR-077 / R-125 (stage 2): tenant isolation for the industry master.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app.
alter table public.industry enable row level security;
--> statement-breakpoint
alter table public.industry force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.industry
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.industry from public;
--> statement-breakpoint
grant select, insert, update, delete on public.industry to cairn_app;
--> statement-breakpoint
alter table public.industry_text enable row level security;
--> statement-breakpoint
alter table public.industry_text force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.industry_text
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.industry_text from public;
--> statement-breakpoint
grant select, insert, update, delete on public.industry_text to cairn_app;
