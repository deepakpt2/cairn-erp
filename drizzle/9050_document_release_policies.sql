-- SCR-060 / R-108 (stage 2): tenant isolation for document release.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client, no PUBLIC rights, DML for
-- cairn_app.
alter table public.document_release enable row level security;
--> statement-breakpoint
alter table public.document_release force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.document_release
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.document_release from public;
--> statement-breakpoint
grant select, insert, update, delete on public.document_release to cairn_app;
