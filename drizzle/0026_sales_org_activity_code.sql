-- SCR-020 uses the approved exact capability/activity code CFG.ORG.SALESORG.DEFINE.
-- Replace the earlier placeholder, repair downstream prerequisites, and derive
-- checklist completion from actual Sales Organization rows (rather than blindly
-- carrying a legacy status whose relationship to persisted configuration is unknown).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM config_activity WHERE code = 'CFG.SALES.SALESORG.DEFINE')
     AND NOT EXISTS (SELECT 1 FROM config_activity WHERE code = 'CFG.ORG.SALESORG.DEFINE') THEN
    INSERT INTO config_activity (
      code, area, sub_area, title, description, activity_kind, prerequisites, enables,
      sequence, wizard_stage, route_path, is_config_only, created_by, created_at, changed_by, changed_at
    )
    SELECT
      'CFG.ORG.SALESORG.DEFINE', area, sub_area, title, description, activity_kind, prerequisites, enables,
      sequence, wizard_stage, route_path, is_config_only, created_by, created_at, changed_by, changed_at
    FROM config_activity
    WHERE code = 'CFG.SALES.SALESORG.DEFINE'
    ON CONFLICT (code) DO NOTHING;
  END IF;
END $$;

-- Merge tenant checklists before removing the legacy activity. A completed status
-- always wins; otherwise an existing non-default target status is retained.
INSERT INTO config_activity_status (
  client, activity_code, status, completed_at, completed_by, note,
  created_by, created_at, changed_by, changed_at
)
SELECT
  client, 'CFG.ORG.SALESORG.DEFINE', status, completed_at, completed_by, note,
  created_by, created_at, changed_by, changed_at
FROM config_activity_status
WHERE activity_code = 'CFG.SALES.SALESORG.DEFINE'
ON CONFLICT (client, activity_code) DO UPDATE SET
  status = CASE
    WHEN config_activity_status.status = 'COMPLETED' OR EXCLUDED.status = 'COMPLETED' THEN 'COMPLETED'
    WHEN config_activity_status.status = 'NOT_STARTED' THEN EXCLUDED.status
    ELSE config_activity_status.status
  END,
  completed_at = COALESCE(config_activity_status.completed_at, EXCLUDED.completed_at),
  completed_by = COALESCE(config_activity_status.completed_by, EXCLUDED.completed_by),
  note = COALESCE(config_activity_status.note, EXCLUDED.note),
  changed_by = COALESCE(config_activity_status.changed_by, EXCLUDED.changed_by),
  changed_at = GREATEST(config_activity_status.changed_at, EXCLUDED.changed_at);

-- Do not carry forward the legacy standard-package completion blindly: that
-- package could mark the old step complete despite creating no Sales Organization.
UPDATE config_activity_status AS s
SET status = CASE
      WHEN EXISTS (SELECT 1 FROM sales_org o WHERE o.client = s.client) THEN 'COMPLETED'
      ELSE 'NOT_STARTED'
    END,
    completed_at = CASE
      WHEN EXISTS (SELECT 1 FROM sales_org o WHERE o.client = s.client)
        THEN (SELECT max(coalesce(o.changed_at, o.created_at)) FROM sales_org o WHERE o.client = s.client)
      ELSE NULL
    END,
    completed_by = CASE
      WHEN EXISTS (SELECT 1 FROM sales_org o WHERE o.client = s.client) THEN 'SCR020_MIGRATION'
      ELSE NULL
    END,
    changed_by = 'SCR020_MIGRATION',
    changed_at = now()
WHERE s.activity_code = 'CFG.ORG.SALESORG.DEFINE';

DELETE FROM config_activity_status
WHERE activity_code = 'CFG.SALES.SALESORG.DEFINE';

UPDATE config_activity
SET prerequisites = replace(prerequisites, 'CFG.SALES.SALESORG.DEFINE', 'CFG.ORG.SALESORG.DEFINE')
WHERE prerequisites LIKE '%CFG.SALES.SALESORG.DEFINE%';

DELETE FROM config_activity
WHERE code = 'CFG.SALES.SALESORG.DEFINE'
  AND EXISTS (SELECT 1 FROM config_activity WHERE code = 'CFG.ORG.SALESORG.DEFINE');
