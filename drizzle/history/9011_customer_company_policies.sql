-- Customer accounting master: tenant default-deny, never privileged web connections.
ALTER TABLE customer_company_code ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_company_code FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_company_tenant ON customer_company_code
 USING(client = nullif(current_setting('cairn.client',true),''))
 WITH CHECK(client = nullif(current_setting('cairn.client',true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON customer_company_code TO cairn_app;
