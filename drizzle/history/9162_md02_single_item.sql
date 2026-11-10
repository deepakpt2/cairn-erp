-- MD02. Single-item planning writes dependent demand for a planned order.
-- The plant run does not explode a typed bill of material.
-- A check writes no operational requirement. A closed row is history, not a delete.
-- An MRP area, lead-time scheduling, and delete-and-recreate are not stored.

ALTER TABLE mrp_run ADD COLUMN IF NOT EXISTS entry_point varchar(16) NOT NULL DEFAULT 'PLANT';
ALTER TABLE mrp_run ADD COLUMN IF NOT EXISTS production_version varchar(4);
ALTER TABLE mrp_run DROP CONSTRAINT IF EXISTS mrp_run_entry_ck;
ALTER TABLE mrp_run ADD CONSTRAINT mrp_run_entry_ck CHECK (entry_point IN ('PLANT', 'SINGLE_ITEM'));

ALTER TABLE mrp_run_material ADD COLUMN IF NOT EXISTS bom_level integer NOT NULL DEFAULT 0;
ALTER TABLE mrp_run_material ADD COLUMN IF NOT EXISTS replan_count integer NOT NULL DEFAULT 0;
ALTER TABLE mrp_run_material ADD COLUMN IF NOT EXISTS explosion_path varchar(500);
ALTER TABLE mrp_run_material DROP CONSTRAINT IF EXISTS mrp_run_material_level_ck;
ALTER TABLE mrp_run_material ADD CONSTRAINT mrp_run_material_level_ck CHECK (bom_level >= 0 AND replan_count >= 0);

CREATE TABLE IF NOT EXISTS mrp_dependent_requirement (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  parent_order_number varchar(12) NOT NULL,
  source_material varchar(40) NOT NULL,
  item_number varchar(4) NOT NULL,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  quantity numeric(23, 3) NOT NULL,
  unit varchar(6) NOT NULL,
  requirement_date date NOT NULL,
  parent_material varchar(40) NOT NULL,
  production_version varchar(4),
  bom_usage char(1),
  bom_alternative varchar(2),
  status varchar(8) NOT NULL DEFAULT 'OPEN',
  run_number varchar(12),
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, parent_order_number, source_material, item_number),
  CONSTRAINT mrp_dependent_requirement_order_fk
    FOREIGN KEY (client, parent_order_number)
    REFERENCES planned_order (client, order_number) ON DELETE RESTRICT,
  CONSTRAINT mrp_dependent_requirement_material_fk
    FOREIGN KEY (client, material_number)
    REFERENCES material (client, material_number) ON DELETE RESTRICT,
  CONSTRAINT mrp_dependent_requirement_plant_fk
    FOREIGN KEY (client, plant)
    REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT mrp_dependent_requirement_qty_ck CHECK (quantity > 0),
  CONSTRAINT mrp_dependent_requirement_status_ck CHECK (status IN ('OPEN', 'CLOSED')),
  CONSTRAINT mrp_dependent_requirement_version_ck CHECK (version > 0)
);

CREATE INDEX IF NOT EXISTS mrp_dependent_requirement_demand_idx
  ON mrp_dependent_requirement (client, material_number, plant, status);

CREATE TABLE IF NOT EXISTS mrp_run_dependent (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  run_number varchar(12) NOT NULL,
  line_number integer NOT NULL,
  parent_material varchar(40) NOT NULL,
  parent_order_number varchar(12),
  component_material varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  quantity numeric(23, 3) NOT NULL,
  unit varchar(6) NOT NULL,
  requirement_date date NOT NULL,
  production_version varchar(4),
  bom_usage char(1),
  bom_alternative varchar(2),
  bom_item varchar(4) NOT NULL,
  source_material varchar(40) NOT NULL,
  bom_level integer NOT NULL DEFAULT 0,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, run_number, line_number),
  CONSTRAINT mrp_run_dependent_run_fk
    FOREIGN KEY (client, run_number)
    REFERENCES mrp_run (client, run_number) ON DELETE CASCADE,
  CONSTRAINT mrp_run_dependent_qty_ck CHECK (quantity > 0),
  CONSTRAINT mrp_run_dependent_line_ck CHECK (line_number > 0)
);

CREATE INDEX IF NOT EXISTS mrp_run_dependent_component_idx
  ON mrp_run_dependent (client, run_number, component_material, plant);

ALTER TABLE mrp_dependent_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_dependent_requirement FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mrp_dependent_requirement;
CREATE POLICY tenant_isolation ON mrp_dependent_requirement
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON mrp_dependent_requirement FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mrp_dependent_requirement TO cairn_app;

ALTER TABLE mrp_run_dependent ENABLE ROW LEVEL SECURITY;
ALTER TABLE mrp_run_dependent FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mrp_run_dependent;
CREATE POLICY tenant_isolation ON mrp_run_dependent
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON mrp_run_dependent FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON mrp_run_dependent TO cairn_app;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'PROD.MRP.SINGLE',
  NULL,
  'Single-item planning',
  'TRANSACTION',
  'PROD',
  'Plan one material and the components of its production version. MD02 is a search alias. The plant run is a different screen. A typed bill of material is not a key. An MRP area, lead-time scheduling, and delete-and-recreate are refused. A check writes no proposal and no dependent requirement. The run posts nothing.',
  'TIER_1_BUILT',
  '/production/single-item-planning',
  'B',
  'MIGRATION_9162'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9162',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MD02', 'SEARCH_ONLY', 'MIGRATION_9162'
FROM term_registry t
WHERE t.our_code = 'PROD.MRP.SINGLE'
ON CONFLICT (external_system, alias) DO NOTHING;
