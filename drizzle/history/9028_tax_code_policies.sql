-- SCR-035 / FTXP stage 2: the tax code table created in 0043 takes the same tenant
-- isolation as every other tenant-local configuration table: RLS forced, no PUBLIC
-- rights, DML for cairn_app.
ALTER TABLE tax_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_code FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tax_code;
CREATE POLICY tenant_isolation ON tax_code
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE tax_code FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tax_code TO cairn_app;
