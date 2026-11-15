-- 9284_cost_allocation_cycle.sql
--
-- Cost allocation cycles (KSU1/KSU2/KSU3) and their execution as assessment (KSU5).
-- A cycle holds segments; a segment names senders, receivers (cost centres or groups),
-- a sender rule (posted actuals) and a receiver rule (percentage, portion, fixed amount).
-- An assessment posts one AL document through the account the tenant names on event
-- CO_ASSESSMENT (no seeded row). One EXECUTED run per cycle, year and period.

create table if not exists public.cost_allocation_cycle (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  controlling_area varchar(4)  not null,
  cycle_code       varchar(6)  not null,
  name             varchar(40) not null,
  category         varchar(12) not null,
  valid_from       date not null,
  valid_to         date not null,
  is_active        boolean not null default true,
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, controlling_area, cycle_code),
  constraint cost_allocation_cycle_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area) on delete cascade,
  constraint cost_allocation_cycle_code_ck check (cycle_code ~ '^[A-Z0-9]{1,6}$'),
  constraint cost_allocation_cycle_category_ck check (category in ('ASSESSMENT','DISTRIBUTION')),
  constraint cost_allocation_cycle_span_ck check (valid_to >= valid_from)
);

create table if not exists public.cost_allocation_segment (
  client            varchar(4)  not null references public.client(client) on delete cascade,
  controlling_area  varchar(4)  not null,
  cycle_code        varchar(6)  not null,
  segment_number    smallint not null,
  name              varchar(40) not null,
  sender_rule       varchar(12) not null default 'POSTED',
  receiver_rule     varchar(14) not null,
  cost_element_from varchar(10),
  cost_element_to   varchar(10),
  created_by        varchar(60) not null default 'SYSTEM',
  created_at        timestamp with time zone not null default now(),
  changed_by        varchar(60),
  changed_at        timestamp with time zone,
  primary key (client, controlling_area, cycle_code, segment_number),
  constraint cost_allocation_segment_cycle_fk foreign key (client, controlling_area, cycle_code)
    references public.cost_allocation_cycle (client, controlling_area, cycle_code) on delete cascade,
  constraint cost_allocation_segment_number_ck check (segment_number between 1 and 999),
  constraint cost_allocation_segment_sender_ck check (sender_rule in ('POSTED')),
  constraint cost_allocation_segment_receiver_ck check (receiver_rule in ('PERCENTAGE','PORTION','FIXED_AMOUNT')),
  constraint cost_allocation_segment_element_ck check (
    (cost_element_from is null and cost_element_to is null)
    or (cost_element_from is not null and cost_element_to is not null and cost_element_from <= cost_element_to))
);

create table if not exists public.cost_allocation_sender (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  controlling_area varchar(4)  not null,
  cycle_code       varchar(6)  not null,
  segment_number   smallint not null,
  item_number      smallint not null,
  cost_center      varchar(10),
  group_name       varchar(24),
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, controlling_area, cycle_code, segment_number, item_number),
  constraint cost_allocation_sender_segment_fk foreign key (client, controlling_area, cycle_code, segment_number)
    references public.cost_allocation_segment (client, controlling_area, cycle_code, segment_number) on delete cascade,
  constraint cost_allocation_sender_exactly_one_ck check (
    (cost_center is not null and group_name is null) or (cost_center is null and group_name is not null))
);

create table if not exists public.cost_allocation_receiver (
  client           varchar(4)  not null references public.client(client) on delete cascade,
  controlling_area varchar(4)  not null,
  cycle_code       varchar(6)  not null,
  segment_number   smallint not null,
  item_number      smallint not null,
  cost_center      varchar(10),
  group_name       varchar(24),
  weight           numeric(23,4) not null,
  created_by       varchar(60) not null default 'SYSTEM',
  created_at       timestamp with time zone not null default now(),
  changed_by       varchar(60),
  changed_at       timestamp with time zone,
  primary key (client, controlling_area, cycle_code, segment_number, item_number),
  constraint cost_allocation_receiver_segment_fk foreign key (client, controlling_area, cycle_code, segment_number)
    references public.cost_allocation_segment (client, controlling_area, cycle_code, segment_number) on delete cascade,
  constraint cost_allocation_receiver_exactly_one_ck check (
    (cost_center is not null and group_name is null) or (cost_center is null and group_name is not null)),
  constraint cost_allocation_receiver_weight_ck check (weight >= 0)
);

create table if not exists public.cost_allocation_run (
  client               varchar(4)  not null references public.client(client) on delete cascade,
  run_id               varchar(36) not null,
  controlling_area     varchar(4)  not null,
  cycle_code           varchar(6)  not null,
  fiscal_year          integer not null,
  period               smallint not null,
  status               varchar(10) not null default 'EXECUTED',
  currency             varchar(3)  not null,
  company_code         varchar(4)  not null,
  assessment_account   varchar(10) not null,
  assessed_total       numeric(23,4) not null,
  segment_count        integer not null default 0,
  sender_count         integer not null default 0,
  receiver_count       integer not null default 0,
  iterations           integer not null default 1,
  document_number      varchar(40) not null,
  document_fiscal_year integer not null,
  request_key          varchar(64) not null,
  executed_by          varchar(60) not null,
  executed_at          timestamp with time zone not null,
  cancelled_by         varchar(60),
  cancelled_at         timestamp with time zone,
  cancel_reason        varchar(500),
  created_by           varchar(60) not null default 'SYSTEM',
  created_at           timestamp with time zone not null default now(),
  changed_by           varchar(60),
  changed_at           timestamp with time zone,
  primary key (client, run_id),
  constraint cost_allocation_run_cycle_fk foreign key (client, controlling_area, cycle_code)
    references public.cost_allocation_cycle (client, controlling_area, cycle_code) on delete restrict,
  constraint cost_allocation_run_period_ck check (period between 1 and 16),
  constraint cost_allocation_run_iterations_ck check (iterations >= 1),
  constraint cost_allocation_run_status_ck check (status in ('EXECUTED','CANCELLED')),
  constraint cost_allocation_run_cancelled_ck check (status <> 'CANCELLED' or (cancelled_by is not null and cancel_reason is not null))
);
-- One live run per cycle, year and period; a cancelled run (its document reversed) frees the period.
create unique index if not exists cost_allocation_run_live_uq
  on public.cost_allocation_run (client, controlling_area, cycle_code, fiscal_year, period)
  where status <> 'CANCELLED';

do $$
declare
  t text;
begin
  foreach t in array array['cost_allocation_cycle','cost_allocation_segment','cost_allocation_sender','cost_allocation_receiver','cost_allocation_run'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update, delete on table public.cost_allocation_cycle to cairn_app;
grant select, insert, update, delete on table public.cost_allocation_segment to cairn_app;
grant select, insert, update, delete on table public.cost_allocation_sender to cairn_app;
grant select, insert, update, delete on table public.cost_allocation_receiver to cairn_app;
-- A run is written once and cancelled; never deleted.
grant select, insert, update on table public.cost_allocation_run to cairn_app;

-- ── Document type AL for tenants that already stand (beside PR) ─────────────
insert into public.document_type
  (client, document_type, name, number_range_object, number_range_sub_object, allowed_account_types, created_by)
select d.client, 'AL', 'Cost allocation', d.number_range_object, d.number_range_sub_object, 'S', 'MIGRATION_9284'
  from public.document_type d
 where d.document_type = 'PR'
on conflict do nothing;

-- ── Capabilities, granted to no role ────────────────────────────────────────
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CFG.COST.ALLOCATION.DEFINE', 'CO', 'DEFINE', false,
   'Define and change cost allocation cycles and their segments (KSU1 / KSU2)'),
  ('CO.ASSESSMENT.EXECUTE', 'CO', 'EXECUTE', false,
   'Execute an assessment cycle, relieving senders and charging receivers (KSU5)')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select v.id, v.our_code, v.our_table, v.title, 'TRANSACTION', 'CO', v.description, 'TIER_1_BUILT',
       '/controlling/allocation-cycles', 'B', null, true, 'MIGRATION_9284', now(), null, null
  from (values
    ('9284a000-0000-4000-8000-000000000001', 'CFG.COST.ALLOCATION.DEFINE', 'cost_allocation_cycle', 'Cost allocation cycles',
     'Define cost allocation cycles: segments with sender and receiver cost centres or groups, and a receiver rule '
     || '(percentage, portion or fixed amount). Distribution cycles can be defined but do not run yet.'),
    ('9284a000-0000-4000-8000-000000000002', 'CO.ASSESSMENT.EXECUTE', 'cost_allocation_run', 'Execute assessment',
     'Execute an assessment cycle for a period: preview, then post one AL document relieving senders and charging '
     || 'receivers through the CO_ASSESSMENT account.')
  ) as v(id, our_code, our_table, title, description)
 where not exists (select 1 from public.term_registry r where r.id = v.id or r.our_code = v.our_code);

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, v.term_id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9284', now()
  from (values
    ('9284b000-0000-4000-8000-000000000001', '9284a000-0000-4000-8000-000000000001', 'KSU1'),
    ('9284b000-0000-4000-8000-000000000002', '9284a000-0000-4000-8000-000000000001', 'KSU2'),
    ('9284b000-0000-4000-8000-000000000003', '9284a000-0000-4000-8000-000000000001', 'KSU3'),
    ('9284b000-0000-4000-8000-000000000004', '9284a000-0000-4000-8000-000000000002', 'KSU5')
  ) as v(id, term_id, alias)
 where exists (select 1 from public.term_registry r where r.id = v.term_id)
   and not exists (select 1 from public.term_alias a where a.id = v.id);
