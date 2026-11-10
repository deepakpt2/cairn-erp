-- The workbench and the command bar named different routes for the same
-- step, and several steps stored a route that has no page. Each standing
-- screen now has one route. A step with no screen stores none.

UPDATE config_activity
SET title = 'Tenant administration',
    route_path = '/clients',
    changed_by = 'MIGRATION_9108',
    changed_at = now()
WHERE code = 'CFG.PLT.CLIENT.DEFINE';

UPDATE config_activity
SET title = 'Number range maintenance',
    route_path = '/config/number-range-objects',
    changed_by = 'MIGRATION_9108',
    changed_at = now()
WHERE code = 'CFG.PLT.NUMBERRANGE.DEFINE';

UPDATE config_activity
SET title = 'Customer credit management',
    enables = 'Customer credit against the delivered credit control area',
    route_path = '/finance/credit',
    changed_by = 'MIGRATION_9108',
    changed_at = now()
WHERE code = 'CFG.FIN.CREDIT.DEFINE';

UPDATE config_activity
SET route_path = NULL,
    changed_by = 'MIGRATION_9108',
    changed_at = now()
WHERE code IN (
  'CFG.PLT.ROLE.DEFINE',
  'CFG.PLT.USER.CREATE',
  'CFG.SALES.PRICING.DEFINE',
  'CFG.SALES.CONDITION.MAINTAIN',
  'CFG.PROD.WORKCENTER.DEFINE',
  'CFG.PROD.MRPCONTROLLER.DEFINE',
  'CFG.PROD.LOTSIZE.DEFINE',
  'CFG.PROD.SCHEDULING.CONFIG',
  'CFG.PEOPLE.RECORDTYPE.DEFINE',
  'CFG.PEOPLE.PAYCOMPONENT.DEFINE',
  'CFG.PEOPLE.DEDUCTION.DEFINE',
  'CFG.PLT.MAIL.DEFINE'
);

DELETE FROM config_activity WHERE code = 'CFG.FIN.INTERCOMPANY.DEFINE';

INSERT INTO term_registry (
  id, our_code, title, term_type, module, description, coverage_tier, route_path, conformance_tier, created_by
) VALUES
  (
    '91080000-0000-4000-8000-000000000001',
    'CFG.ORG.PLANT.ASSIGN_COMPANY',
    'Assign plant to company code',
    'CONFIG_ACTIVITY',
    'FND',
    'Assign an unassigned plant to a company code. The assignment is maintained on the plant screen, not on a second page.',
    'TIER_2_CONFIGURED',
    '/config/plants',
    'B',
    'MIGRATION_9108'
  ),
  (
    '91080000-0000-4000-8000-000000000002',
    'CFG.PROC.PURGROUP.DEFINE',
    'Define purchasing groups',
    'CONFIG_ACTIVITY',
    'PROC',
    'Define purchasing groups: a three-character key and the buyer contact. A group is not assigned to a purchasing organisation, a company code or a plant.',
    'TIER_2_CONFIGURED',
    '/config/purchasing-groups',
    'B',
    'MIGRATION_9108'
  ),
  (
    '91080000-0000-4000-8000-000000000003',
    'CFG.COST.CONTROLLINGAREA.DEFINE',
    'Define controlling area',
    'CONFIG_ACTIVITY',
    'COST',
    'Define a controlling area. Company-code assignment is the separate screen. OKKP is a search alias only.',
    'TIER_2_CONFIGURED',
    '/config/controlling-area',
    'B',
    'MIGRATION_9108'
  ),
  (
    '91080000-0000-4000-8000-000000000004',
    'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY',
    'Assign controlling area to company code',
    'CONFIG_ACTIVITY',
    'COST',
    'Assign a company code to a controlling area. OX19 is a search alias only. The assignment is not part of the area definition screen.',
    'TIER_2_CONFIGURED',
    '/config/controlling-area/assign-company-code',
    'B',
    'MIGRATION_9108'
  ),
  (
    '91080000-0000-4000-8000-000000000005',
    'CFG.FIN.CREDIT.DEFINE',
    'Customer credit management',
    'CONFIG_ACTIVITY',
    'FIN',
    'Maintain customer credit for a credit control area. The area itself is delivered with the standard structure; this screen does not create one. FD32 remains the transaction alias on the same screen.',
    'TIER_1_BUILT',
    '/finance/credit',
    'B',
    'MIGRATION_9108'
  )
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  coverage_tier = excluded.coverage_tier,
  changed_by = 'MIGRATION_9108',
  changed_at = now();

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT '91080000-0000-4000-8000-000000000013', t.id, 'REFERENCE_ERP', 'OKKP', 'SEARCH_ONLY', 'MIGRATION_9108'
FROM term_registry t
WHERE t.our_code = 'CFG.COST.CONTROLLINGAREA.DEFINE'
ON CONFLICT (external_system, alias) DO NOTHING;

INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT '91080000-0000-4000-8000-000000000014', t.id, 'REFERENCE_ERP', 'OX19', 'SEARCH_ONLY', 'MIGRATION_9108'
FROM term_registry t
WHERE t.our_code = 'CFG.COST.CONTROLLINGAREA.ASSIGN_COMPANY'
ON CONFLICT (external_system, alias) DO NOTHING;
