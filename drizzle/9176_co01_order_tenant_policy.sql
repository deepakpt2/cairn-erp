-- Production orders were created without the tenant policy later tables use.
-- CO01 stores a component snapshot on these rows. A read under another client
-- must not see it. The application still filters by client. This is the second line.

ALTER TABLE production_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_order;
CREATE POLICY tenant_isolation ON production_order
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));

ALTER TABLE production_order_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_order_component FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON production_order_component;
CREATE POLICY tenant_isolation ON production_order_component
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
