-- ME38 may cancel a delivery schedule line. The line stays. Posted history is not deleted.
-- A firm zone, a fixed indicator, and a supplier release are not added here.

alter table public.scheduling_agreement_schedule_line
  add column marked_for_deletion boolean not null default false;

insert into capability (code, module, action, is_posting_relevant, description)
values
  ('PROC.SCHEDLINE.MAINTAIN', 'PROC', 'CREATE', false, 'Maintain delivery schedule lines for a scheduling agreement. ME38 does not post stock or send a supplier release.'),
  ('PROC.SCHEDLINE.DISPLAY', 'PROC', 'DISPLAY', false, 'Display delivery schedule lines. ME39 writes nothing.')
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
    gen_random_uuid()::text, 'PROC.SCHEDLINE.MAINTAIN', 'scheduling_agreement_schedule_line', 'Delivery schedule',
    'TRANSACTION', 'PROC',
    'Maintain delivery schedule lines for a scheduling agreement. ME38 is a search alias. Saving does not create an agreement, a purchase order, a goods receipt, or a supplier release.',
    'TIER_1_BUILT', '/purchasing/delivery-schedule', 'B', 'MIGRATION_9151'
  ),
  (
    gen_random_uuid()::text, 'PROC.SCHEDLINE.DISPLAY', null, 'Display delivery schedule',
    'TRANSACTION', 'PROC',
    'Display delivery schedule lines. ME39 is a search alias. Display writes nothing.',
    'TIER_1_BUILT', '/purchasing/delivery-schedule-display', 'B', 'MIGRATION_9151'
  )
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9151',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9151'
from (values
  ('PROC.SCHEDLINE.MAINTAIN', 'ME38'),
  ('PROC.SCHEDLINE.DISPLAY', 'ME39')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;
