-- SCR-029 / OB29 stage 2: the rebuild in 0038 dropped both tables, and a dropped table takes
-- its policies with it. Re-applied in the same pattern as every other tenant-local
-- configuration table: RLS forced, no PUBLIC rights, DML for cairn_app.
ALTER TABLE fiscal_year_variant ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year_variant FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON fiscal_year_variant;
CREATE POLICY tenant_isolation ON fiscal_year_variant
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE fiscal_year_variant FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fiscal_year_variant TO cairn_app;

ALTER TABLE fiscal_year_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_year_period FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON fiscal_year_period;
CREATE POLICY tenant_isolation ON fiscal_year_period
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE fiscal_year_period FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE fiscal_year_period TO cairn_app;
