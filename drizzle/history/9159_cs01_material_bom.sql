-- CS01 / CS02 / CS03. Plant-specific material BOM.
-- Usage, status, and item category are tenant customizing. None is seeded.
-- Engineering change management is not implemented. A change number is refused.
-- Valid-to is stored because DATUB is derived in the reference model and no change master stands.
-- Saving does not explode a BOM, post a cost, or rewrite a production order.

CREATE TABLE bom_usage (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  usage char(1) NOT NULL,
  description varchar(40) NOT NULL,
  production_relevance char(1) NOT NULL DEFAULT '.',
  engineering_relevance char(1) NOT NULL DEFAULT '.',
  costing_relevance char(1) NOT NULL DEFAULT '.',
  sales_relevance char(1) NOT NULL DEFAULT '.',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, usage),
  CONSTRAINT bom_usage_key_ck CHECK (usage ~ '^[A-Z0-9]$'),
  CONSTRAINT bom_usage_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT bom_usage_relevance_ck CHECK (
    production_relevance IN ('+', '.', '-')
    AND engineering_relevance IN ('+', '.', '-')
    AND costing_relevance IN ('+', '.', '-')
    AND sales_relevance IN ('+', '.', '-')
  ),
  CONSTRAINT bom_usage_version_ck CHECK (version > 0)
);

CREATE TABLE bom_status (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  status char(2) NOT NULL,
  description varchar(40) NOT NULL,
  released_for_mrp char(1) NOT NULL DEFAULT ' ',
  released_for_costing char(1) NOT NULL DEFAULT ' ',
  released_for_orders char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, status),
  CONSTRAINT bom_status_key_ck CHECK (status ~ '^[0-9]{2}$'),
  CONSTRAINT bom_status_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT bom_status_release_ck CHECK (
    released_for_mrp IN ('X', ' ')
    AND released_for_costing IN ('X', ' ')
    AND released_for_orders IN ('X', ' ')
  ),
  CONSTRAINT bom_status_version_ck CHECK (version > 0)
);

CREATE TABLE bom_item_category (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  category char(1) NOT NULL,
  description varchar(40) NOT NULL,
  material_entry char(1) NOT NULL,
  quantity_entry char(1) NOT NULL,
  allow_fixed_quantity char(1) NOT NULL DEFAULT ' ',
  allow_bulk char(1) NOT NULL DEFAULT ' ',
  allow_phantom char(1) NOT NULL DEFAULT ' ',
  allow_coproduct char(1) NOT NULL DEFAULT ' ',
  allow_follow_up char(1) NOT NULL DEFAULT ' ',
  allow_special_procurement char(1) NOT NULL DEFAULT ' ',
  allow_negative_quantity char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, category),
  CONSTRAINT bom_item_category_key_ck CHECK (category ~ '^[A-Z0-9]$'),
  CONSTRAINT bom_item_category_description_ck CHECK (char_length(btrim(description)) BETWEEN 1 AND 40),
  CONSTRAINT bom_item_category_entry_ck CHECK (material_entry IN ('+', '.', '-') AND quantity_entry IN ('+', '.', '-')),
  CONSTRAINT bom_item_category_flags_ck CHECK (
    allow_fixed_quantity IN ('X', ' ')
    AND allow_bulk IN ('X', ' ')
    AND allow_phantom IN ('X', ' ')
    AND allow_coproduct IN ('X', ' ')
    AND allow_follow_up IN ('X', ' ')
    AND allow_special_procurement IN ('X', ' ')
    AND allow_negative_quantity IN ('X', ' ')
  ),
  CONSTRAINT bom_item_category_version_ck CHECK (version > 0)
);

CREATE TABLE material_bom (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  usage char(1) NOT NULL,
  alternative varchar(2) NOT NULL,
  bom_number char(8) NOT NULL,
  status char(2),
  base_quantity numeric(23, 3) NOT NULL,
  base_unit varchar(6) NOT NULL REFERENCES unit_of_measure (code),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  header_text varchar(40),
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  request_key varchar(64),
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, material_number, plant, usage, alternative),
  CONSTRAINT material_bom_material_plant_fk
    FOREIGN KEY (client, material_number, plant)
    REFERENCES material_plant (client, material_number, plant) ON DELETE RESTRICT,
  CONSTRAINT material_bom_usage_fk
    FOREIGN KEY (client, usage) REFERENCES bom_usage (client, usage) ON DELETE RESTRICT,
  CONSTRAINT material_bom_status_fk
    FOREIGN KEY (client, status) REFERENCES bom_status (client, status) ON DELETE RESTRICT,
  CONSTRAINT material_bom_alternative_ck CHECK (alternative ~ '^[A-Z0-9]{1,2}$'),
  CONSTRAINT material_bom_number_ck CHECK (bom_number ~ '^[0-9]{8}$'),
  CONSTRAINT material_bom_quantity_ck CHECK (base_quantity > 0),
  CONSTRAINT material_bom_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT material_bom_text_ck CHECK (header_text IS NULL OR char_length(btrim(header_text)) BETWEEN 1 AND 40),
  CONSTRAINT material_bom_deletion_ck CHECK (deletion_flag IN ('X', ' ')),
  CONSTRAINT material_bom_version_ck CHECK (version > 0)
);

CREATE UNIQUE INDEX material_bom_number_alt_uq ON material_bom (client, bom_number, alternative);
CREATE UNIQUE INDEX material_bom_request_uq ON material_bom (client, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX material_bom_selection_idx ON material_bom (client, material_number, plant, usage);

CREATE TABLE material_bom_item (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  material_number varchar(40) NOT NULL,
  plant varchar(10) NOT NULL,
  usage char(1) NOT NULL,
  alternative varchar(2) NOT NULL,
  item_number varchar(4) NOT NULL,
  item_category char(1) NOT NULL,
  component_material varchar(40),
  quantity numeric(23, 3),
  unit varchar(6) REFERENCES unit_of_measure (code),
  scrap_percent numeric(5, 2),
  sort_string varchar(10),
  item_text varchar(40),
  valid_from date NOT NULL,
  valid_to date NOT NULL,
  fixed_quantity char(1) NOT NULL DEFAULT ' ',
  bulk_material char(1) NOT NULL DEFAULT ' ',
  phantom char(1) NOT NULL DEFAULT ' ',
  coproduct char(1) NOT NULL DEFAULT ' ',
  follow_up_material varchar(40),
  special_procurement varchar(2),
  issuing_plant varchar(10),
  deletion_flag char(1) NOT NULL DEFAULT ' ',
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, material_number, plant, usage, alternative, item_number),
  CONSTRAINT material_bom_item_header_fk
    FOREIGN KEY (client, material_number, plant, usage, alternative)
    REFERENCES material_bom (client, material_number, plant, usage, alternative) ON DELETE CASCADE,
  CONSTRAINT material_bom_item_category_fk
    FOREIGN KEY (client, item_category) REFERENCES bom_item_category (client, category) ON DELETE RESTRICT,
  CONSTRAINT material_bom_item_component_fk
    FOREIGN KEY (client, component_material) REFERENCES material (client, material_number) ON DELETE RESTRICT,
  CONSTRAINT material_bom_item_follow_up_fk
    FOREIGN KEY (client, follow_up_material) REFERENCES material (client, material_number) ON DELETE RESTRICT,
  CONSTRAINT material_bom_item_issuing_plant_fk
    FOREIGN KEY (client, issuing_plant) REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT material_bom_item_number_ck CHECK (item_number ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT material_bom_item_dates_ck CHECK (valid_to >= valid_from),
  CONSTRAINT material_bom_item_quantity_ck CHECK (quantity IS NULL OR quantity <> 0),
  CONSTRAINT material_bom_item_unit_ck CHECK (quantity IS NULL OR unit IS NOT NULL),
  CONSTRAINT material_bom_item_scrap_ck CHECK (scrap_percent IS NULL OR (scrap_percent >= 0 AND scrap_percent <= 999.99)),
  CONSTRAINT material_bom_item_text_ck CHECK (item_text IS NULL OR char_length(btrim(item_text)) BETWEEN 1 AND 40),
  CONSTRAINT material_bom_item_flags_ck CHECK (
    fixed_quantity IN ('X', ' ')
    AND bulk_material IN ('X', ' ')
    AND phantom IN ('X', ' ')
    AND coproduct IN ('X', ' ')
    AND deletion_flag IN ('X', ' ')
  )
);

CREATE INDEX material_bom_item_component_idx ON material_bom_item (client, component_material);

ALTER TABLE bom_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bom_usage
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON bom_usage FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON bom_usage TO cairn_app;

ALTER TABLE bom_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_status FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bom_status
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON bom_status FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON bom_status TO cairn_app;

ALTER TABLE bom_item_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE bom_item_category FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bom_item_category
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON bom_item_category FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON bom_item_category TO cairn_app;

ALTER TABLE material_bom ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_bom FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON material_bom
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON material_bom FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON material_bom TO cairn_app;

ALTER TABLE material_bom_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_bom_item FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON material_bom_item
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON material_bom_item FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON material_bom_item TO cairn_app;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.PROD.BOM.DEFINE',
  'PRODUCTION',
  NULL,
  'Define material BOM',
  'DEFINE',
  'CFG.ORG.PLANT.DEFINE',
  'A plant-specific material BOM a later order or planning run can select. This screen does not explode it.',
  967,
  'ONBOARDING',
  '/production/boms',
  true,
  'MIGRATION_9159'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9159',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.BOM.DEFINE', 'NOT_STARTED', 'MIGRATION_9159'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  ('PROD.BOM.CREATE', 'PROD', 'CREATE', false, 'Create a material BOM. CS01 is a search alias. Saving does not explode, cost, or rewrite an order.'),
  ('PROD.BOM.CHANGE', 'PROD', 'CHANGE', false, 'Change a material BOM. CS02 is a search alias. A change number is refused. A saved order is not rewritten.'),
  ('PROD.BOM.DISPLAY', 'PROD', 'DISPLAY', false, 'Display a material BOM. CS03 is a search alias. Display writes nothing.')
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES
  (
    gen_random_uuid()::text, 'PROD.BOM.CREATE', 'material_bom', 'Create material BOM',
    'TRANSACTION', 'PROD',
    'Create a plant-specific material BOM. CS01 is a search alias. Usage, status, and item category are tenant data. No usage 1 is delivered. A change number is refused. Validity is the from and to dates. Saving does not explode the BOM or rewrite a production order.',
    'TIER_1_BUILT', '/production/boms', 'B', 'MIGRATION_9159'
  ),
  (
    gen_random_uuid()::text, 'PROD.BOM.CHANGE', null, 'Change material BOM',
    'TRANSACTION', 'PROD',
    'Change a material BOM. CS02 is a search alias. The material, plant, usage, and alternative are fixed. Item numbers are kept. A saved production order is not rewritten.',
    'TIER_1_BUILT', '/production/boms', 'B', 'MIGRATION_9159'
  ),
  (
    gen_random_uuid()::text, 'PROD.BOM.DISPLAY', null, 'Display material BOM',
    'TRANSACTION', 'PROD',
    'Display a material BOM. CS03 is a search alias. Display writes nothing and takes no change lock.',
    'TIER_1_BUILT', '/production/bom-display', 'B', 'MIGRATION_9159'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9159',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9159'
FROM (VALUES
  ('PROD.BOM.CREATE', 'CS01'),
  ('PROD.BOM.CHANGE', 'CS02'),
  ('PROD.BOM.DISPLAY', 'CS03')
) AS v(our_code, alias)
JOIN term_registry t ON t.our_code = v.our_code
ON CONFLICT (external_system, alias) DO NOTHING;

UPDATE term_registry
SET description = 'The order master a component issue posts against. Components are a snapshot. Creating an order does not read a material BOM, and a later BOM change does not rewrite the order. The company code is derived from the plant. Creating an order posts nothing and moves no stock.',
    changed_by = 'MIGRATION_9159',
    changed_at = now()
WHERE our_code = 'PROD.ORDER.CREATE';

UPDATE term_registry
SET description = 'Total planning for a plant. This run does not explode a bill of material. Dependent demand is the open reservation. A buy shortage becomes a purchase requisition. A make shortage becomes a planned order. The run posts nothing.',
    changed_by = 'MIGRATION_9159',
    changed_at = now()
WHERE our_code = 'PROD.MRP.RUN';
