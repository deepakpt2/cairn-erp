-- Inventory master data joins the same default-deny tenant boundary.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['material_type','material_group','valuation_class','mrp_controller',
    'material','material_plant','material_valuation','planning_file'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL
      USING (client = current_setting(''cairn.client'', true))
      WITH CHECK (client = current_setting(''cairn.client'', true))', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO cairn_app', t);
  END LOOP;
END $$;
