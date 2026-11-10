-- Customer sales-area master: tenant default-deny, never privileged web connections.
ALTER TABLE customer_sales_area ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sales_area FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_sales_area_tenant ON customer_sales_area
 USING(client = nullif(current_setting('cairn.client',true),''))
 WITH CHECK(client = nullif(current_setting('cairn.client',true),''));
GRANT SELECT,INSERT,UPDATE,DELETE ON customer_sales_area TO cairn_app;
