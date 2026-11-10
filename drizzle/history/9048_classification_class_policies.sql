-- SCR-058 / R-106 (stage 2): tenant isolation for classes.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client, no PUBLIC rights, DML for
-- cairn_app.
alter table public.class_type enable row level security;
--> statement-breakpoint
alter table public.class_type force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.class_type
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.class_type from public;
--> statement-breakpoint
grant select, insert, update, delete on public.class_type to cairn_app;
--> statement-breakpoint
alter table public.classification_class enable row level security;
--> statement-breakpoint
alter table public.classification_class force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.classification_class
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.classification_class from public;
--> statement-breakpoint
grant select, insert, update, delete on public.classification_class to cairn_app;
--> statement-breakpoint
alter table public.class_assignment enable row level security;
--> statement-breakpoint
alter table public.class_assignment force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.class_assignment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.class_assignment from public;
--> statement-breakpoint
grant select, insert, update, delete on public.class_assignment to cairn_app;
