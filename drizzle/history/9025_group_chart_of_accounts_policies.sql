-- SCR-026 / OB13 amendment: tenant isolation and application-role access for the
-- Group Chart of Accounts registry. Mirrors the policy pattern used by every other
-- tenant-local configuration table: RLS forced, no PUBLIC rights, DML for cairn_app.
ALTER TABLE group_chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_chart_of_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON group_chart_of_accounts
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE group_chart_of_accounts FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON group_chart_of_accounts TO cairn_app';
  END IF;
END $$;
