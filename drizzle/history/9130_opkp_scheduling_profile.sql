-- OPKP is the production scheduling profile, TCO43, not T399X.
-- The key is client, plant, and the profile as typed, at most six characters.
-- Only the settings this system executes are stored: release at creation
-- (X or blank) and batch creation in the order (blank, 1, or 2).

CREATE TABLE production_scheduling_profile (
  client varchar(4) NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  plant varchar(10) NOT NULL,
  profile varchar(6) NOT NULL,
  description varchar(40) NOT NULL,
  release_on_create char(1) NOT NULL DEFAULT ' ',
  batch_creation char(1) NOT NULL DEFAULT ' ',
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  PRIMARY KEY (client, plant, profile),
  CONSTRAINT production_scheduling_profile_plant_fk
    FOREIGN KEY (client, plant) REFERENCES plant (client, plant) ON DELETE RESTRICT,
  CONSTRAINT production_scheduling_profile_key_ck CHECK (char_length(profile) BETWEEN 1 AND 6),
  CONSTRAINT production_scheduling_profile_description_ck CHECK (char_length(description) BETWEEN 1 AND 40),
  CONSTRAINT production_scheduling_profile_release_ck CHECK (release_on_create IN ('X', ' ')),
  CONSTRAINT production_scheduling_profile_batch_ck CHECK (batch_creation IN (' ', '1', '2')),
  CONSTRAINT production_scheduling_profile_version_ck CHECK (version > 0)
);

CREATE INDEX production_scheduling_profile_plant_idx
  ON production_scheduling_profile (client, plant);

ALTER TABLE production_scheduling_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE production_scheduling_profile FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON production_scheduling_profile
  USING (client = current_setting('cairn.client', true))
  WITH CHECK (client = current_setting('cairn.client', true));
REVOKE ALL ON production_scheduling_profile FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON production_scheduling_profile TO cairn_app;

ALTER TABLE material_plant
  ADD COLUMN scheduling_profile varchar(6);

ALTER TABLE material_plant
  ADD CONSTRAINT material_plant_scheduling_profile_fk
  FOREIGN KEY (client, plant, scheduling_profile)
  REFERENCES production_scheduling_profile (client, plant, profile);

ALTER TABLE production_order
  ADD COLUMN scheduling_profile varchar(6) NOT NULL DEFAULT '',
  ADD COLUMN release_on_create char(1) NOT NULL DEFAULT ' ',
  ADD COLUMN batch_creation char(1) NOT NULL DEFAULT ' ';

ALTER TABLE production_order
  ADD CONSTRAINT production_order_release_on_create_ck CHECK (release_on_create IN ('X', ' ')),
  ADD CONSTRAINT production_order_batch_creation_ck CHECK (batch_creation IN (' ', '1', '2'));

INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES (
  'CFG.PROD.SCHEDPROFILE.DEFINE',
  'PROD',
  'CONFIGURE',
  false,
  'Define a production scheduling profile. OPKP is a search alias only. The key is the plant and a profile of at most six characters. Release at creation is X or blank. Batch creation in the order is blank, 1, or 2. It does not post a goods receipt.'
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
  'CFG.PROD.SCHEDPROFILE.DEFINE',
  'PRODUCTION',
  NULL,
  'Define production scheduling profile',
  'DEFINE',
  'CFG.ORG.PLANT.DEFINE',
  'Profile for release at creation and batch creation in the order',
  965,
  'STANDARD',
  '/config/scheduling-profiles',
  true,
  'MIGRATION_9130'
)
ON CONFLICT (code) DO UPDATE SET
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9130',
  changed_at = now();

INSERT INTO config_activity_status (client, activity_code, status, created_by)
SELECT c.client, 'CFG.PROD.SCHEDPROFILE.DEFINE', 'NOT_STARTED', 'MIGRATION_9130'
FROM client c
ON CONFLICT (client, activity_code) DO NOTHING;

INSERT INTO role_capability (client, role_code, capability_code, created_by)
SELECT rc.client, rc.role_code, 'CFG.PROD.SCHEDPROFILE.DEFINE', 'MIGRATION_9130'
FROM role_capability rc
WHERE rc.capability_code IN (
  'PROD.ORDER.CREATE',
  'CFG.ORG.PLANT.DEFINE',
  'CFG.PLT.CLIENT.ONBOARD'
)
ON CONFLICT (client, role_code, capability_code) DO NOTHING;

INSERT INTO term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
VALUES (
  gen_random_uuid()::text,
  'CFG.PROD.SCHEDPROFILE.DEFINE',
  NULL,
  'Production scheduling profile',
  'CONFIG_ACTIVITY',
  'PROD',
  $opkp$Production scheduling profile. OPKP is a search alias only. The key is the plant and a profile of at most six characters, stored as typed. Release at creation is the character X or blank. Batch creation in the order is blank, 1, or 2. A material plant assignment is stored on the plant view. An existing order keeps the profile it was created with. This screen does not print, schedule, check availability, check capacity, post a goods receipt, classify a batch, or create an order type. T399X is not this profile. Opening this screen writes nothing.$opkp$,
  'TIER_2_CONFIGURED',
  '/config/scheduling-profiles',
  'B',
  'MIGRATION_9130'
)
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'MIGRATION_9130',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'OPKP', 'SEARCH_ONLY', 'MIGRATION_9130'
FROM term_registry t
WHERE t.our_code = 'CFG.PROD.SCHEDPROFILE.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;
