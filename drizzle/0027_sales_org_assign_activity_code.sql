-- SCR-021 uses the approved exact capability/activity code CFG.ORG.SALESORG.ASSIGN_COMPANY.
-- Replace the earlier placeholder (CFG.SALES.SALESORG.ASSIGN_COMPANY), repair downstream
-- prerequisites, and derive checklist completion from actual Sales Organization assignments
-- rather than carrying a placeholder status forward.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM config_activity WHERE code = 'CFG.SALES.SALESORG.ASSIGN_COMPANY')
     AND NOT EXISTS (SELECT 1 FROM config_activity WHERE code = 'CFG.ORG.SALESORG.ASSIGN_COMPANY') THEN
    INSERT INTO config_activity (
      code, area, sub_area, title, description, activity_kind, prerequisites, enables,
      sequence, wizard_stage, route_path, is_config_only, created_by, created_at, changed_by, changed_at
    )
    SELECT
      'CFG.ORG.SALESORG.ASSIGN_COMPANY', area, sub_area, title, description, activity_kind, prerequisites, enables,
      sequence, wizard_stage, '/config/sales-orgs/assign-company', is_config_only, created_by, created_at, changed_by, changed_at
    FROM config_activity
    WHERE code = 'CFG.SALES.SALESORG.ASSIGN_COMPANY'
    ON CONFLICT (code) DO NOTHING;
  END IF;
END $$;

-- Merge tenant checklists before removing the placeholder activity. A completed status
-- always wins; otherwise an existing non-default target status is retained.
INSERT INTO config_activity_status (
  client, activity_code, status, completed_at, completed_by, note,
  created_by, created_at, changed_by, changed_at
)
SELECT
  client, 'CFG.ORG.SALESORG.ASSIGN_COMPANY', status, completed_at, completed_by, note,
  created_by, created_at, changed_by, changed_at
FROM config_activity_status
WHERE activity_code = 'CFG.SALES.SALESORG.ASSIGN_COMPANY'
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

-- A tenant whose Sales Organizations still carry no Company Code has not completed this
-- step, whatever the placeholder said; a tenant that already holds an assignment has.
UPDATE config_activity_status AS s
SET status = CASE
      WHEN EXISTS (SELECT 1 FROM sales_org o WHERE o.client = s.client AND o.company_code IS NOT NULL) THEN 'COMPLETED'
      ELSE 'NOT_STARTED'
    END,
    completed_at = CASE
      WHEN EXISTS (SELECT 1 FROM sales_org o WHERE o.client = s.client AND o.company_code IS NOT NULL)
        THEN (SELECT max(coalesce(o.changed_at, o.created_at)) FROM sales_org o WHERE o.client = s.client AND o.company_code IS NOT NULL)
      ELSE NULL
    END,
    completed_by = CASE
      WHEN EXISTS (SELECT 1 FROM sales_org o WHERE o.client = s.client AND o.company_code IS NOT NULL) THEN 'SCR021_MIGRATION'
      ELSE NULL
    END,
    changed_by = 'SCR021_MIGRATION',
    changed_at = now()
WHERE s.activity_code = 'CFG.ORG.SALESORG.ASSIGN_COMPANY';

DELETE FROM config_activity_status
WHERE activity_code = 'CFG.SALES.SALESORG.ASSIGN_COMPANY';

UPDATE config_activity
SET prerequisites = replace(prerequisites, 'CFG.SALES.SALESORG.ASSIGN_COMPANY', 'CFG.ORG.SALESORG.ASSIGN_COMPANY')
WHERE prerequisites LIKE '%CFG.SALES.SALESORG.ASSIGN_COMPANY%';

DELETE FROM config_activity
WHERE code = 'CFG.SALES.SALESORG.ASSIGN_COMPANY'
  AND EXISTS (SELECT 1 FROM config_activity WHERE code = 'CFG.ORG.SALESORG.ASSIGN_COMPANY');
