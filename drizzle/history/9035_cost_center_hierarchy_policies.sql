-- SCR-042 / R-91 (stage 2): tenant isolation for the hierarchy tables.
--
-- Same pattern as every tenant registry: RLS enabled and forced, one
-- tenant_isolation policy on cairn.client (the setting the platform
-- sets), no PUBLIC rights, DML for cairn_app. All five tables here.
alter table public.cost_center_hierarchy enable row level security;
--> statement-breakpoint
alter table public.cost_center_hierarchy force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center_hierarchy
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.cost_center_hierarchy from public;
--> statement-breakpoint
grant select, insert, update, delete on public.cost_center_hierarchy to cairn_app;
--> statement-breakpoint
alter table public.cost_center_node enable row level security;
--> statement-breakpoint
alter table public.cost_center_node force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center_node
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.cost_center_node from public;
--> statement-breakpoint
grant select, insert, update, delete on public.cost_center_node to cairn_app;
--> statement-breakpoint
alter table public.cost_center_node_assignment enable row level security;
--> statement-breakpoint
alter table public.cost_center_node_assignment force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center_node_assignment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.cost_center_node_assignment from public;
--> statement-breakpoint
grant select, insert, update, delete on public.cost_center_node_assignment to cairn_app;
--> statement-breakpoint
alter table public.cost_center_group enable row level security;
--> statement-breakpoint
alter table public.cost_center_group force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center_group
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.cost_center_group from public;
--> statement-breakpoint
grant select, insert, update, delete on public.cost_center_group to cairn_app;
--> statement-breakpoint
alter table public.cost_center_group_leaf enable row level security;
--> statement-breakpoint
alter table public.cost_center_group_leaf force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center_group_leaf
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.cost_center_group_leaf from public;
--> statement-breakpoint
grant select, insert, update, delete on public.cost_center_group_leaf to cairn_app;
--> statement-breakpoint
