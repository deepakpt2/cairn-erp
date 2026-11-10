-- OVXK assignment relation: tenant isolation and application-role access.
ALTER TABLE sales_org_distribution_channel ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_org_distribution_channel FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON sales_org_distribution_channel
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE sales_org_distribution_channel FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON sales_org_distribution_channel TO cairn_app';
  END IF;
END $$;
