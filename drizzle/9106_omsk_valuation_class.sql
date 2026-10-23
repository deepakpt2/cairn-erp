-- OMSK maintains the standing account category reference and valuation
-- class. The assignment is its own row so one class may belong to more
-- than one reference. It does not add a G/L account, a version, or a
-- transport, and it does not post.

ALTER TABLE account_category_reference
  ADD COLUMN is_active boolean NOT NULL DEFAULT true;

CREATE TABLE valuation_class_reference (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  reference varchar(4) NOT NULL,
  valuation_class varchar(20) NOT NULL,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client, reference, valuation_class),
  CONSTRAINT valuation_class_reference_reference_fk
    FOREIGN KEY (client, reference)
    REFERENCES account_category_reference (client, reference)
    ON DELETE RESTRICT,
  CONSTRAINT valuation_class_reference_class_fk
    FOREIGN KEY (client, valuation_class)
    REFERENCES valuation_class (client, valuation_class)
    ON DELETE RESTRICT
);

CREATE INDEX valuation_class_reference_class_idx
  ON valuation_class_reference (client, valuation_class);

ALTER TABLE valuation_class_reference ENABLE ROW LEVEL SECURITY;
ALTER TABLE valuation_class_reference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON valuation_class_reference
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON valuation_class_reference FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON valuation_class_reference TO cairn_app;

-- Delivered classes name material types. Assign each class to the
-- account category reference those types already carry, so the new
-- check does not refuse a class a material may already hold.
INSERT INTO valuation_class_reference (client, reference, valuation_class, created_by)
SELECT DISTINCT vc.client, mt.account_category_reference, vc.valuation_class, 'MIGRATION_9106'
FROM valuation_class vc
JOIN material_type mt
  ON mt.client = vc.client
 AND mt.material_type = ANY (string_to_array(vc.allowed_material_types, ','))
ON CONFLICT DO NOTHING;

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.INV.VALCLASS.DEFINE',
  'INV',
  'CONFIGURE',
  false,
  'Define valuation classes and the account category references that permit them'
)
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

INSERT INTO config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
VALUES (
  'CFG.INV.VALCLASS.DEFINE',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Define valuation classes',
  'DEFINE',
  'CFG.INV.MATERIALTYPE.DEFINE',
  'Material valuation',
  100,
  'ONBOARDING',
  '/config/valuation-classes',
  true,
  'MIGRATION_9106'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9106',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
SELECT
  c.client,
  'CFG.INV.VALCLASS.DEFINE',
  CASE
    WHEN EXISTS (SELECT 1 FROM valuation_class v WHERE v.client = c.client) THEN 'COMPLETED'
    ELSE 'NOT_STARTED'
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM valuation_class v WHERE v.client = c.client) THEN now()
    ELSE NULL
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM valuation_class v WHERE v.client = c.client) THEN 'MIGRATION_9106'
    ELSE NULL
  END,
  'MIGRATION_9106'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.INV.VALCLASS.DEFINE',
  NULL,
  'Define valuation classes',
  'CONFIG_ACTIVITY',
  'INV',
  $omsk$Define valuation classes and the account category references that permit them. OMSK is a search alias only. The reference key is one to four letters or digits and keeps its leading zeros. The class key is the material master own key, one to twenty letters, digits or underscores, and is never converted to a number, so 0001 stays 0001. A class may be assigned to more than one reference. A material type already names one reference; changing that reference does not rewrite a material valuation class, and the change is refused when standing materials would no longer be allowed their class. A material may carry a class only when the class is active and assigned to the type reference. A delivered class also names the material types it was supplied for, so the raw class stays with raw materials while those types share one reference. An empty type list permits every type on the assigned references. A class a material or an account determination already names cannot be deactivated or deleted; the counts are named, and the description may still change. A posted document is not rewritten. A G/L account is not stored on the class. A closed posting period does not block this screen. A transport, a version and an approval are refused by name. The change document is the history.$omsk$,
  'TIER_2_CONFIGURED',
  '/config/valuation-classes',
  'B',
  'MIGRATION_9106'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9106',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OMSK', 'SEARCH_ONLY', 'MIGRATION_9106'
FROM term_registry t
WHERE t.our_code = 'CFG.INV.VALCLASS.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
