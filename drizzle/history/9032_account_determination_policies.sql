-- SCR-040 / OBYC stage 2: the account determination table created in
-- 0049 takes the same tenant isolation as every other tenant-local
-- configuration table: RLS forced, no PUBLIC rights, DML for cairn_app.
ALTER TABLE account_determination ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_determination FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON account_determination;
CREATE POLICY tenant_isolation ON account_determination
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE account_determination FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE account_determination TO cairn_app;
