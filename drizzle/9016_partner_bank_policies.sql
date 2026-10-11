-- B-072: tenant-scoped read policy only; writes stay disabled until the gated save path exists.
ALTER TABLE partner_bank ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_bank FORCE ROW LEVEL SECURITY;
CREATE POLICY partner_bank_tenant_select ON partner_bank
  FOR SELECT
  USING (client = nullif(current_setting('cairn.client', true), ''));

-- 9000 grants DML on all tables. Revoke it here and allow only scoped reads;
-- tenant deletion still follows D-041 via the client FK cascade.
REVOKE ALL PRIVILEGES ON TABLE partner_bank FROM cairn_app;
GRANT SELECT ON TABLE partner_bank TO cairn_app;
