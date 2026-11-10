-- Payment Methods definitions are tenant-scoped; runtime must never bypass RLS.
ALTER TABLE payment_method ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_method FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_method_tenant ON payment_method
  USING (client = nullif(current_setting('cairn.client', true),''))
  WITH CHECK (client = nullif(current_setting('cairn.client', true),''));
GRANT SELECT, INSERT, UPDATE, DELETE ON payment_method TO cairn_app;
