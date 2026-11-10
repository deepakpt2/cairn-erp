-- Supplier partner-function configuration and assignments are tenant-scoped.
ALTER TABLE supplier_partner_function ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_partner_function FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_partner_function_tenant ON supplier_partner_function
  USING(client = nullif(current_setting('cairn.client', true),''))
  WITH CHECK(client = nullif(current_setting('cairn.client', true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON supplier_partner_function TO cairn_app;

ALTER TABLE supplier_purchasing_partner ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_purchasing_partner FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_purchasing_partner_tenant ON supplier_purchasing_partner
  USING(client = nullif(current_setting('cairn.client', true),''))
  WITH CHECK(client = nullif(current_setting('cairn.client', true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON supplier_purchasing_partner TO cairn_app;
