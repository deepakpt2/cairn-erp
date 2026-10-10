-- Tenant default-deny payment configuration; runtime must never bypass RLS.
ALTER TABLE payment_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_terms_tenant ON payment_terms
  USING (client = nullif(current_setting('cairn.client', true), ''))
  WITH CHECK (client = nullif(current_setting('cairn.client', true), ''));
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_terms TO cairn_app;
