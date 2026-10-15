-- SCR-028 (FS00) replaced the read-only G/L account list with three maintenance
-- activities: create (FS00), change (FSP0) and display (FSS0). This migration
-- brings an existing database to the same end state a fresh seed produces: the
-- legacy Term Registry entry FIN.GL.MASTER.LIST and the capability
-- FIN.GL.MASTER.CREATE are retired, and three CFG.FIN.GLACCOUNT.* activities take
-- their place — the same one-activity-per-maintenance-screen shape as OB13.
--
-- Role grants need no repair. role_capability deliberately has no foreign key and
-- stores PATTERNS resolved at authorisation time (src/platform/tables/security.ts),
-- so CFG.FIN.GLACCOUNT.* reaches ADMINISTRATOR (*) and CONFIGURATOR (CFG.*) on its
-- own. The consequence to remember: the retired FIN.GL.MASTER.CREATE matched the
-- ACCOUNTANT pattern FIN.*, and G/L account maintenance is now configuration work.

-- 1. Capabilities for the three activities.
INSERT INTO capability (code, module, action, is_posting_relevant, description)
VALUES
  ('CFG.FIN.GLACCOUNT.CREATE', 'FIN', 'CONFIGURE', false,
   'Create a G/L account master record in an active, unblocked chart of accounts'),
  ('CFG.FIN.GLACCOUNT.CHANGE', 'FIN', 'CONFIGURE', false,
   'Change a G/L account master record, its posting and creation blocks, the account group registry and its field status matrix'),
  ('CFG.FIN.GLACCOUNT.DISPLAY', 'FIN', 'DISPLAY', false,
   'Display G/L account master records, the account group registry and their change history')
ON CONFLICT (code) DO UPDATE SET
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- 2. Retire the legacy term before the new entries claim its aliases. term_alias is
--    unique on (external_system, alias), so FS00 and FSP0 have to be released first;
--    term_alias.term_id cascades, so the aliases leave with the term.
DELETE FROM term_registry WHERE our_code = 'FIN.GL.MASTER.LIST';

-- 3. One CONFIG_ACTIVITY term per maintenance screen, modelled on CFG.FIN.COA.DEFINE.
--    DISPLAY keeps the hub route /config/gl-accounts rather than /view: route_path is
--    what the registry search, the command palette and the Configuration Workbench
--    "Open" link navigate to, and the hub is the only one of the four G/L routes that
--    means something without query parameters. Display mode is reached from the hub,
--    which lists every account in the chart with its Display, Change and block actions.
INSERT INTO term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier,
   route_path, conformance_tier, created_by)
VALUES
  (gen_random_uuid()::text, 'CFG.FIN.GLACCOUNT.CREATE', NULL,
   'G/L account master create', 'CONFIG_ACTIVITY', 'FIN',
   'Create a G/L account in an active, unblocked chart of accounts. The account number is validated against the chart length and the account group range, stays immutable for the life of the account, and every other field takes its status from the account group field status matrix.',
   'TIER_2_CONFIGURED', '/config/gl-accounts/new', 'B', 'SCR028_MIGRATION'),
  (gen_random_uuid()::text, 'CFG.FIN.GLACCOUNT.CHANGE', NULL,
   'G/L account master change', 'CONFIG_ACTIVITY', 'FIN',
   'Change a G/L account, its posting and creation blocks, the account group registry with its from/to ranges, and the per-field Suppress/Optional/Mandatory matrix. A reason is mandatory for a block change and for deletion, and deletion is refused while any balance, line item, open item or reconciliation assignment still uses the account.',
   'TIER_2_CONFIGURED', '/config/gl-accounts/edit', 'B', 'SCR028_MIGRATION'),
  (gen_random_uuid()::text, 'CFG.FIN.GLACCOUNT.DISPLAY', NULL,
   'G/L account master display', 'CONFIG_ACTIVITY', 'FIN',
   'Read G/L account master records, the account group registry and their change history. A blocked chart of accounts keeps its read-only display while refusing new accounts. Display mode itself is /config/gl-accounts/view; the hub below is the entry point that needs no selection.',
   'TIER_2_CONFIGURED', '/config/gl-accounts', 'B', 'SCR028_MIGRATION')
ON CONFLICT (our_code) DO UPDATE SET
  title = excluded.title,
  term_type = excluded.term_type,
  module = excluded.module,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  conformance_tier = excluded.conformance_tier,
  changed_by = 'SCR028_MIGRATION',
  changed_at = now();

-- 4. Move the FS00 and FSP0 aliases onto their own activities and add FSS0.
INSERT INTO term_alias (id, term_id, external_system, alias, usage, created_by)
SELECT gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'SCR028_MIGRATION'
FROM (VALUES
       ('CFG.FIN.GLACCOUNT.CREATE', 'FS00'),
       ('CFG.FIN.GLACCOUNT.CHANGE', 'FSP0'),
       ('CFG.FIN.GLACCOUNT.DISPLAY', 'FSS0')
     ) AS v(our_code, alias)
JOIN term_registry t ON t.our_code = v.our_code
ON CONFLICT (external_system, alias) DO NOTHING;

-- 5. Retire the legacy capability, but only once its replacement exists.
DELETE FROM capability
WHERE code = 'FIN.GL.MASTER.CREATE'
  AND EXISTS (SELECT 1 FROM capability WHERE code = 'CFG.FIN.GLACCOUNT.CREATE');
