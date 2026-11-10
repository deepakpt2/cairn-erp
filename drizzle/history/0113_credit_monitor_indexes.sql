-- SCR-104 / R-152 (stage 2): the monitor is read-only; the only
-- schema act is indexing. The credit record gains the
-- (tenant, area, customer) access path the overview scans by,
-- and journal lines gain the open-item-by-customer path the
-- exposure aggregation filters on.
create index customer_credit_area_idx
  on public.customer_credit (client, credit_control_area, customer);
--> statement-breakpoint
create index journal_entry_line_partner_open_idx
  on public.journal_entry_line (client, business_partner, clearing_document);
