-- SCR-037 / FI12 stage 2: the house bank and bank account tables created in
-- 0045 take the same tenant isolation as every other tenant-local
-- configuration table: RLS forced, no PUBLIC rights, DML for cairn_app.
-- The bank master they refer to is global and deliberately carries no such
-- policy (9029); these rows are a tenant's own and do.
ALTER TABLE house_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE house_bank FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON house_bank;
CREATE POLICY tenant_isolation ON house_bank
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

ALTER TABLE bank_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bank_account;
CREATE POLICY tenant_isolation ON bank_account
  FOR ALL
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

REVOKE ALL ON TABLE house_bank, bank_account FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE house_bank, bank_account TO cairn_app;
