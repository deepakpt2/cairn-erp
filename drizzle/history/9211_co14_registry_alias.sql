-- CO14 is an additional search alias for the existing production-order display.
-- The display already lists its posted confirmations; no new screen, capability,
-- role, or authorization rule is introduced here.
DO $$
DECLARE
  v_term_id varchar(36);
  v_alias_term_id varchar(36);
BEGIN
  INSERT INTO term_registry
    (id, our_code, our_table, title, term_type, module, description, coverage_tier,
     route_path, conformance_tier, created_by)
  VALUES
    (gen_random_uuid()::text, 'PROD.ORDER.DISPLAY', NULL, 'Display production order', 'TRANSACTION', 'PROD',
     'Display a production order. CO03 and CO14 are search aliases. The number is the key. Quantity, dates, status, components, and a stored planned-order link are shown as stored. Issued and received quantities are read from material documents. An order type, operations, and sequences are not stored. Display writes nothing.',
     'TIER_1_BUILT', '/production/production-order-display', 'B', 'MIGRATION_9211')
  ON CONFLICT (our_code) DO UPDATE SET
    our_table = EXCLUDED.our_table,
    title = EXCLUDED.title,
    term_type = EXCLUDED.term_type,
    module = EXCLUDED.module,
    description = EXCLUDED.description,
    coverage_tier = EXCLUDED.coverage_tier,
    route_path = EXCLUDED.route_path,
    conformance_tier = EXCLUDED.conformance_tier,
    changed_by = 'MIGRATION_9211',
    changed_at = now()
  RETURNING id INTO v_term_id;

  INSERT INTO term_alias
    (id, term_id, external_system, alias, usage, created_by)
  VALUES
    (gen_random_uuid()::text, v_term_id, 'REFERENCE_ERP', 'CO14', 'SEARCH_ONLY', 'MIGRATION_9211')
  ON CONFLICT (external_system, alias) DO NOTHING;

  -- An alias is globally unique per source system. Never silently leave CO14
  -- pointing at a different registry entry if one already owns the alias.
  SELECT term_id INTO v_alias_term_id
    FROM term_alias
   WHERE external_system = 'REFERENCE_ERP'
     AND alias = 'CO14';

  IF v_alias_term_id IS DISTINCT FROM v_term_id THEN
    RAISE EXCEPTION 'CO14 is already assigned to a different registry term; refusing to misroute the alias';
  END IF;
END $$;
