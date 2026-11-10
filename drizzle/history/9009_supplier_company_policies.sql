-- Company supplier settings remain tenant-scoped even for financial administrators.
ALTER TABLE supplier_company_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_company_code FORCE ROW LEVEL SECURITY;
CREATE POLICY supplier_company_tenant ON supplier_company_code
  USING(client = nullif(current_setting('cairn.client',true),''))
  WITH CHECK(client = nullif(current_setting('cairn.client',true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON supplier_company_code TO cairn_app;
