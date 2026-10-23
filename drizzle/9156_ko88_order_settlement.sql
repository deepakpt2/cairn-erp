-- KO88 and KO8G name the settlement entry points.
-- No settlement profile, distribution rule, allocation structure, receiver,
-- percentage, or settlement account is stored. Neither transaction posts.
-- KO8B, KO9E, CO88, and CJ88 are not registered here.

insert into capability (code, module, action, is_posting_relevant, description)
values
  (
    'CO.SETTLE.ORDER', 'CO', 'CREATE', false,
    'KO88 actual settlement for one internal order. It does not post until a settlement rule exists, and none is configured.'
  ),
  (
    'CO.SETTLE.COLLECTIVE', 'CO', 'CREATE', false,
    'KO8G actual settlement for a selection of internal orders. It uses the same settlement check as KO88 and does not post.'
  )
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values
  (
    gen_random_uuid()::text, 'CO.SETTLE.ORDER', null, 'Actual settlement',
    'TRANSACTION', 'CO',
    'Settle one internal order. KO88 is a search alias. No receiver or percentage is assumed. An update does not post while no settlement rule is configured.',
    'TIER_1_BUILT', '/controlling/order-settlement', 'B', 'MIGRATION_9156'
  ),
  (
    gen_random_uuid()::text, 'CO.SETTLE.COLLECTIVE', null, 'Collective actual settlement',
    'TRANSACTION', 'CO',
    'Settle a selection of internal orders. KO8G is a search alias. It calls the same settlement check as KO88. Maintenance orders are not configured. CO88 is not this screen.',
    'TIER_1_BUILT', '/controlling/order-settlement-collective', 'B', 'MIGRATION_9156'
  )
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9156',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9156'
from (values
  ('CO.SETTLE.ORDER', 'KO88'),
  ('CO.SETTLE.COLLECTIVE', 'KO8G')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
