-- Purchasing master stays tenant-scoped; the app never gains RLS bypass.
ALTER TABLE supplier_purchasing_org ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_purchasing_org FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_purchasing_tenant ON supplier_purchasing_org
  USING(client = nullif(current_setting('cairn.client',true),''))
  WITH CHECK(client = nullif(current_setting('cairn.client',true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON supplier_purchasing_org TO cairn_app;
