-- SCR-028 / FS00 stage 2: tenant isolation and application-role access for the three
-- tables the G/L account master gained. Mirrors the policy pattern used by every other
-- tenant-local configuration table: RLS forced, no PUBLIC rights, DML for cairn_app.
ALTER TABLE gl_account_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_account_group FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON gl_account_group
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE gl_account_group FROM PUBLIC;

ALTER TABLE gl_account_group_field_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE gl_account_group_field_status FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON gl_account_group_field_status
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE gl_account_group_field_status FROM PUBLIC;

ALTER TABLE group_chart_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_chart_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON group_chart_accounts
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE group_chart_accounts FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON gl_account_group TO cairn_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON gl_account_group_field_status TO cairn_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON group_chart_accounts TO cairn_app';
  END IF;
END $$;
