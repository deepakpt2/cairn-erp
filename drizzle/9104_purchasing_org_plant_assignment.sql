-- OX17 maintains the standing purchasing_org_plant row. The activity was
-- declared in seed with the define-screen route, and a provisioned database
-- that has not been reseeded does not carry the capability or the search
-- alias. This brings that registry to the same end state a fresh seed
-- produces. It does not add a second assignment table, and it does not post.

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROC.PURORG.ASSIGN_PLANT',
  'PROC',
  'CONFIGURE',
  false,
  'Assign an active tenant Purchasing Organisation to an active plant of the same company code'
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
  'CFG.PROC.PURORG.ASSIGN_PLANT',
  'MATERIALS_MANAGEMENT',
  NULL,
  'Assign purchasing organisation to plant',
  'ASSIGN',
  'CFG.PROC.PURORG.DEFINE,CFG.ORG.PLANT.DEFINE',
  'Plant procurement',
  100,
  'ONBOARDING',
  '/config/purchasing-orgs/assign-plant',
  true,
  'MIGRATION_9104'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  changed_by = 'MIGRATION_9104',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, completed_at, completed_by, created_by)
SELECT
  c.client,
  'CFG.PROC.PURORG.ASSIGN_PLANT',
  CASE
    WHEN EXISTS (SELECT 1 FROM purchasing_org_plant p WHERE p.client = c.client) THEN 'COMPLETED'
    ELSE 'NOT_STARTED'
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM purchasing_org_plant p WHERE p.client = c.client) THEN now()
    ELSE NULL
  END,
  CASE
    WHEN EXISTS (SELECT 1 FROM purchasing_org_plant p WHERE p.client = c.client) THEN 'MIGRATION_9104'
    ELSE NULL
  END,
  'MIGRATION_9104'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROC.PURORG.ASSIGN_PLANT',
  NULL,
  'Assign purchasing organisation to plant',
  'CONFIG_ACTIVITY',
  'PROC',
  $ox17$Assign an active purchasing organisation to an active plant. The company code is read from the plant and is not stored on the assignment. One organisation may buy for several plants of its company, and a plant may be served by several organisations. A pair a procurement document already cites is not removed, and the document is not rewritten. OX17 is a search alias only.$ox17$,
  'TIER_2_CONFIGURED',
  '/config/purchasing-orgs/assign-plant',
  'B',
  'MIGRATION_9104'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9104',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OX17', 'SEARCH_ONLY', 'MIGRATION_9104'
FROM term_registry t
WHERE t.our_code = 'CFG.PROC.PURORG.ASSIGN_PLANT'
ON CONFLICT (external_system, alias) DO NOTHING;

-- The pair already stands. These foreign keys name the masters the row
-- already means. They do not add a status, a version, or a company code.
ALTER TABLE purchasing_org_plant
  ADD CONSTRAINT purchasing_org_plant_org_fk
  FOREIGN KEY (client, purchasing_org)
  REFERENCES purchasing_org (client, purchasing_org)
  ON DELETE RESTRICT;

ALTER TABLE purchasing_org_plant
  ADD CONSTRAINT purchasing_org_plant_plant_fk
  FOREIGN KEY (client, plant)
  REFERENCES plant (client, plant)
  ON DELETE RESTRICT;
