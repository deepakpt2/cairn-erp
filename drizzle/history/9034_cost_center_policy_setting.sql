-- SCR-041 / R-90 (stage 5 correction): the cost_center tenant policy
-- named the wrong session setting (`app.current_client`); the platform
-- sets `cairn.client` (src/platform/db/client.ts), as every other tenant
-- policy reads. 9033 stands immutable; this restates the policy.
drop policy tenant_isolation on public.cost_center;
--> statement-breakpoint
create policy tenant_isolation on public.cost_center
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
