-- DI-020: supplier credit memo link.
--
-- The purchasing schema declares the optional link from a supplier credit memo
-- to its original invoice. The authoritative supplier_invoice table was created
-- before that field was introduced, so add it forward-only for migrated and
-- freshly provisioned databases alike. Existing table grants already apply.
alter table public.supplier_invoice
  add column credit_of varchar(20);
