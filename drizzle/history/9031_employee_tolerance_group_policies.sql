-- SCR-039 / OBA4 stage 2: the employee tolerance group table created in
-- 0047 takes the same tenant isolation as every other tenant-local
-- configuration table: RLS forced, no PUBLIC rights, DML for cairn_app.
ALTER TABLE employee_tolerance_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_tolerance_group FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON employee_tolerance_group;
CREATE POLICY tenant_isolation ON employee_tolerance_group
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE employee_tolerance_group FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE employee_tolerance_group TO cairn_app;
