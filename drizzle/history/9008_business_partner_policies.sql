-- General partner tables: default-deny tenant scope; no privileged web runtime.
ALTER TABLE business_partner ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_partner FORCE ROW LEVEL SECURITY;
CREATE POLICY business_partner_tenant ON business_partner
  USING(client = nullif(current_setting('cairn.client', true),''))
  WITH CHECK(client = nullif(current_setting('cairn.client', true),''));
ALTER TABLE bp_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE bp_role FORCE ROW LEVEL SECURITY;
CREATE POLICY bp_role_tenant ON bp_role
  USING(client = nullif(current_setting('cairn.client', true),''))
  WITH CHECK(client = nullif(current_setting('cairn.client', true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON business_partner,bp_role TO cairn_app;
