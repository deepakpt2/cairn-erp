-- MB5M reads the batch shelf-life date and unrestricted stock that already stand.
-- The material shelf-life fields are client-level. A plant does not store a copy.
-- This migration does not create a stock table and does not rewrite a batch date.

alter table material
  add column if not exists min_remaining_shelf_life integer,
  add column if not exists total_shelf_life integer,
  add column if not exists storage_percentage integer,
  add column if not exists sled_period_indicator char(1);

alter table material drop constraint if exists material_min_shelf_life_ck;
alter table material add constraint material_min_shelf_life_ck
  check (min_remaining_shelf_life is null or (min_remaining_shelf_life >= 0 and min_remaining_shelf_life <= 9999));

alter table material drop constraint if exists material_total_shelf_life_ck;
alter table material add constraint material_total_shelf_life_ck
  check (total_shelf_life is null or (total_shelf_life >= 0 and total_shelf_life <= 9999));

alter table material drop constraint if exists material_storage_percentage_ck;
alter table material add constraint material_storage_percentage_ck
  check (storage_percentage is null or (storage_percentage >= 1 and storage_percentage <= 999));

alter table material drop constraint if exists material_sled_period_ck;
alter table material add constraint material_sled_period_ck
  check (sled_period_indicator is null or sled_period_indicator in (' ', '1', '2', '3'));

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'INV.SLED.LIST',
  'INV',
  'DISPLAY',
  false,
  'Shelf life list. MB5M is a search alias only. The list reads unrestricted batch stock and the stored expiration date. It does not post, and it does not change a batch date.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'INV.SLED.LIST', 'MIGRATION_9146'
from role_capability rc
where rc.capability_code in ('INV.STOCK.WAREHOUSE', 'INV.BATCH.DISPLAY', 'INV.BATCH.PICKUP')
on conflict (client, role_code, capability_code) do nothing;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'INV.SLED.LIST',
  'material',
  'Shelf life list',
  'TRANSACTION',
  'INV',
  $mb5m$Shelf life list. MB5M is a search alias only, program RM07MMHD. It lists unrestricted batch stock by the stored shelf-life expiration date. A blank remaining-shelf-life field lists batches already expired. A number of days lists batches whose remaining life is at most that many days. Total remaining life is the expiration date less the key date. Warehouse remaining life is shown only when a storage percentage and a minimum remaining shelf life stand, and it is not the same figure. The quantity is unrestricted stock, not the sum of material documents, and not quality or blocked stock. A missing expiration date is named and not invented. Opening the list writes nothing.$mb5m$,
  'TIER_1_BUILT',
  '/inventory/shelf-life-list',
  'B',
  'MIGRATION_9146'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9146',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'MB5M', 'SEARCH_ONLY', 'MIGRATION_9146'
from term_registry t
where t.our_code = 'INV.SLED.LIST'
on conflict (external_system, alias) do nothing;
