-- SCR-061 / R-109 (stage 2): tenant isolation for goods movements.
--
-- Posted material documents are immutable at the permission level:
-- the application role may insert and read, and may only ever update
-- the header's reversal columns. Lines are insert-only.
alter table public.movement_type enable row level security;
--> statement-breakpoint
alter table public.movement_type force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.movement_type
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.movement_type from public;
--> statement-breakpoint
grant select, insert, update, delete on public.movement_type to cairn_app;
--> statement-breakpoint
alter table public.material_document enable row level security;
--> statement-breakpoint
alter table public.material_document force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.material_document
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.material_document from public;
--> statement-breakpoint
grant select, insert on public.material_document to cairn_app;
--> statement-breakpoint
grant update (status, reversed_by, changed_by, changed_at) on public.material_document to cairn_app;
--> statement-breakpoint
alter table public.material_document_line enable row level security;
--> statement-breakpoint
alter table public.material_document_line force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.material_document_line
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.material_document_line from public;
--> statement-breakpoint
grant select, insert on public.material_document_line to cairn_app;
--> statement-breakpoint
alter table public.stock_quantity enable row level security;
--> statement-breakpoint
alter table public.stock_quantity force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.stock_quantity
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.stock_quantity from public;
--> statement-breakpoint
grant select, insert, update, delete on public.stock_quantity to cairn_app;
