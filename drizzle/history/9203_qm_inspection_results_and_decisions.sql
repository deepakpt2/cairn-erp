-- QM slice 2 — inspection results, usage decisions, and quality stock.
--
-- CAIRN.md §10.11, decisions D1 to D5 (2026-10-28). Slice 1 (migration 9192) added the inspection lot
-- as a record with no power over stock. This slice adds what the lot was always for: measured results
-- against configured characteristics, a usage decision that accepts or rejects the goods, and the stock
-- movement that follows the decision.
--
-- What is deliberately NOT here:
--   * sampling procedures, inspection plans, or automatic characteristic derivation. A characteristic is
--     configured explicitly, and a result is recorded against it explicitly. The owner's characteristic
--     maintenance screen is deferred.
--   * quality notifications and nonconformance records. A rejected usage decision is a fact on the lot;
--     what happens next (return to vendor, scrap, rework) is a later round.
--   * automatic stock posting on decision. The decision is recorded first; the stock movement that
--     follows (quality to unrestricted, or quality to blocked) is a separate act that names the decision.
--   * WIP calculation (DV-003) and variance categorization (DV-004) remain deferred.

-- One characteristic a lot can be inspected against: quantitative (measured, toleranced) or qualitative
-- (pass/fail or a configured value set). The unit stands on quantitative characteristics only.
create table if not exists public.inspection_characteristic (
  client varchar(4) not null references public.client (client) on delete cascade,
  characteristic_code varchar(16) not null,
  description varchar(80) not null,
  characteristic_type varchar(16) not null,
  tolerance_plus numeric(13, 4),
  tolerance_minus numeric(13, 4),
  unit varchar(6),
  valid_from date not null default '2020-01-01',
  valid_to date not null default '9999-12-31',
  created_by varchar(60) not null default 'SYSTEM',
  changed_by varchar(60),
  changed_at timestamptz,
  constraint inspection_characteristic_pk primary key (client, characteristic_code),
  constraint inspection_characteristic_type_ck
    check (characteristic_type in ('QUANTITATIVE', 'QUALITATIVE')),
  constraint inspection_characteristic_tolerance_ck
    check (
      (tolerance_plus is null and tolerance_minus is null)
      or (tolerance_plus >= 0 and tolerance_minus <= 0)
    ),
  constraint inspection_characteristic_unit_ck
    check (
      characteristic_type = 'QUALITATIVE'
      or (unit is not null and length(trim(unit)) > 0)
    ),
  constraint inspection_characteristic_validity_ck
    check (valid_to >= valid_from)
);

-- One measured result against one characteristic on one lot. A lot may have many results; a result
-- names exactly one characteristic. Quantitative results carry a measured value and unit; qualitative
-- results carry a result value (e.g. 'PASS', 'FAIL') and no unit.
create table if not exists public.inspection_result (
  client varchar(4) not null references public.client (client) on delete cascade,
  lot_number varchar(20) not null,
  characteristic_code varchar(16) not null,
  result_value varchar(40) not null,
  measured_unit varchar(6),
  result_status varchar(16) not null default 'RECORDED',
  recorded_by varchar(60) not null default 'SYSTEM',
  recorded_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint inspection_result_pk primary key (client, lot_number, characteristic_code),
  constraint inspection_result_lot_fk
    foreign key (client, lot_number)
    references public.quality_lot (client, lot_number) on delete restrict,
  constraint inspection_result_characteristic_fk
    foreign key (client, characteristic_code)
    references public.inspection_characteristic (client, characteristic_code) on delete restrict,
  constraint inspection_result_status_ck
    check (result_status in ('RECORDED', 'ACCEPTED', 'REJECTED'))
);

-- The usage decision on one lot: accept, reject, or another configured outcome. One decision per lot;
-- a later change supersedes the earlier one and the earlier one is kept as history. The decision
-- gates whether the goods may move from quality inspection stock to unrestricted or blocked stock.
create table if not exists public.usage_decision (
  client varchar(4) not null references public.client (client) on delete cascade,
  lot_number varchar(20) not null,
  decision_code varchar(16) not null,
  decision_date date not null default CURRENT_DATE,
  decided_by varchar(60) not null default 'SYSTEM',
  stock_posted boolean not null default false,
  stock_document_number varchar(20),
  stock_document_line integer,
  created_by varchar(60) not null default 'SYSTEM',
  changed_by varchar(60),
  changed_at timestamptz,
  constraint usage_decision_pk primary key (client, lot_number),
  constraint usage_decision_lot_fk
    foreign key (client, lot_number)
    references public.quality_lot (client, lot_number) on delete restrict,
  constraint usage_decision_code_ck
    check (decision_code in ('ACCEPT', 'REJECT', 'BLOCK', 'REWORK')),
  constraint usage_decision_stock_pair_ck
    check (
      (stock_posted = false and stock_document_number is null and stock_document_line is null)
      or (stock_posted = true and stock_document_number is not null and stock_document_line is not null)
    )
);

-- Row-level security on the new tables.
do $$
declare
  target text;
begin
  foreach target in array array[
    'inspection_characteristic',
    'inspection_result',
    'usage_decision'
  ]
  loop
    execute format('alter table public.%I enable row level security', target);
    execute format('alter table public.%I force row level security', target);
    execute format(
      'create policy tenant_isolation on public.%I using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      target
    );
    execute format('revoke all on public.%I from public', target);
    execute format('grant select, insert, update, delete on public.%I to cairn_app', target);
  end loop;
end $$;

-- Capabilities for slice 2.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'QM.INSPECTION.RECORD', 'QM', 'CREATE', false,
  'Record an inspection result against a characteristic on an inspection lot (QA32). Quantitative and '
  || 'qualitative characteristics, tolerance validation, unit of measure, result status.'
) on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'QM.USAGE.DECIDE', 'QM', 'CREATE', true,
  'Record a usage decision on an inspection lot (QE51N): accept, reject, block or rework. Validates that '
  || 'mandatory results are complete, prevents duplicate decisions, and gates the following stock movement.'
) on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'QM.STOCK.POST', 'QM', 'CREATE', true,
  'Post quality stock movement from inspection results (QA11): move accepted quality stock to unrestricted, '
  || 'rejected quality stock to blocked. Atomic with the usage decision so partial failure cannot leave '
  || 'inconsistent stock.'
) on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- Grant the new capabilities to the warehouse clerk (who receives and inspects goods) and the quality
-- role pattern that tenants may adopt. No QM role model exists yet; the codes are offered to the roles
-- that already stand where inspection results and decisions would be noticed.
insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'QM.INSPECTION.RECORD', 'MIGRATION_9203'
  from role_capability rc
 where rc.capability_code in ('INV.GR.POST', 'QM.LOT.CREATE')
on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'QM.USAGE.DECIDE', 'MIGRATION_9203'
  from role_capability rc
 where rc.capability_code in ('INV.GR.POST', 'QM.LOT.CREATE')
on conflict (client, role_code, capability_code) do nothing;

insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'QM.STOCK.POST', 'MIGRATION_9203'
  from role_capability rc
 where rc.capability_code in ('INV.GR.POST', 'QM.LOT.CREATE')
on conflict (client, role_code, capability_code) do nothing;

-- Registry entries.
insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values (
  gen_random_uuid()::text, 'QM.INSPECTION.RECORD', 'inspection_result', 'Inspection result',
  'TRANSACTION', 'QM',
  'A measured or observed result against one characteristic on one inspection lot. Quantitative results '
  || 'carry a value, unit and tolerance check; qualitative results carry a result value. Partial recording '
  || 'is supported; a lot may have many results.',
  'TIER_2_CONFIGURED', '/quality/inspection', 'C', 'MIGRATION_9203'
) on conflict (our_code) do update set
  title = excluded.title, description = excluded.description,
  route_path = excluded.route_path, our_table = excluded.our_table,
  changed_by = 'MIGRATION_9203', changed_at = now();

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values (
  gen_random_uuid()::text, 'QM.USAGE.DECIDE', 'usage_decision', 'Usage decision',
  'TRANSACTION', 'QM',
  'The accept/reject/block/rework decision on one inspection lot. Validates that mandatory results are '
  || 'complete before the decision is recorded, prevents duplicate decisions, and gates whether the goods '
  || 'may leave quality inspection stock.',
  'TIER_2_CONFIGURED', '/quality/inspection', 'C', 'MIGRATION_9203'
) on conflict (our_code) do update set
  title = excluded.title, description = excluded.description,
  route_path = excluded.route_path, our_table = excluded.our_table,
  changed_by = 'MIGRATION_9203', changed_at = now();

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
) values (
  gen_random_uuid()::text, 'QM.STOCK.POST', null, 'Quality stock movement',
  'TRANSACTION', 'QM',
  'Moves stock between quality inspection, unrestricted-use and blocked stock categories following a usage '
  || 'decision. Accepted quality stock moves to unrestricted; rejected quality stock moves to blocked. '
  || 'Posted atomically with the usage decision so partial failure cannot leave inconsistent stock.',
  'TIER_2_CONFIGURED', '/quality/inspection', 'C', 'MIGRATION_9203'
) on conflict (our_code) do update set
  title = excluded.title, description = excluded.description,
  route_path = excluded.route_path, our_table = excluded.our_table,
  changed_by = 'MIGRATION_9203', changed_at = now();

-- Aliases for SAP transaction search.
insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9203'
from (values
  ('QM.INSPECTION.RECORD', 'QA32'),
  ('QM.USAGE.DECIDE', 'QE51N'),
  ('QM.STOCK.POST', 'QA11')
) as v(our_code, alias)
join term_registry t on t.our_code = v.our_code
on conflict (external_system, alias) do nothing;