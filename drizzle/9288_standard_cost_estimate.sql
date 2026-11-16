-- 9288_standard_cost_estimate.sql
--
-- Standard cost estimate (CK11N / CK13N): one material in one plant on a costing date, saved with its
-- full itemization. Two tables. An estimate is evidence, so a newer estimate for the same material,
-- plant and costing date marks the older SUPERSEDED rather than deleting it. Nothing here writes a
-- price: releasing an estimate to the material master is CK24 (a later item).
-- Also: capability PROD.COST.ESTIMATE.CREATE (granted to no role, as CO.PLAN.COSTCENTER.MAINTAIN is),
-- its registry entry and the aliases CK11N / CK13N.

create table if not exists public.material_cost_estimate (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  material_number    varchar(40) not null,
  plant              varchar(10) not null,
  costing_date       date        not null,
  costing_version    varchar(2)  not null,
  status             varchar(10) not null,
  costing_lot_size   numeric(23,3) not null,
  currency           char(3)     not null,
  total_cost         numeric(23,4) not null,
  unit_cost          numeric(23,4) not null,
  material_cost      numeric(23,4) not null,
  activity_cost      numeric(23,4) not null,
  overhead_cost      numeric(23,4) not null default 0,
  production_version varchar(4)  not null,
  controlling_area   varchar(4)  not null,
  plan_version       varchar(3)  not null,
  request_key        varchar(64),
  costed_by          varchar(60) not null,
  costed_at          timestamp with time zone not null default now(),
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  primary key (client, material_number, plant, costing_date, costing_version),
  constraint material_cost_estimate_status_ck check (status in ('SAVED','SUPERSEDED')),
  constraint material_cost_estimate_lot_ck check (costing_lot_size > 0),
  constraint material_cost_estimate_split_ck check (total_cost = material_cost + activity_cost + overhead_cost),
  constraint material_cost_estimate_overhead_ck check (overhead_cost = 0)
);
-- One SAVED estimate per material, plant and costing date.
create unique index if not exists material_cost_estimate_live_uq
  on public.material_cost_estimate (client, material_number, plant, costing_date) where status = 'SAVED';
create unique index if not exists material_cost_estimate_request_uq
  on public.material_cost_estimate (client, request_key) where request_key is not null;

create table if not exists public.material_cost_estimate_item (
  client             varchar(4)  not null,
  material_number    varchar(40) not null,
  plant              varchar(10) not null,
  costing_date       date        not null,
  costing_version    varchar(2)  not null,
  line_number        integer     not null,
  item_type          varchar(8)  not null,
  level              integer     not null,
  component_material varchar(40),
  operation_number   varchar(4),
  work_center        varchar(8),
  cost_center        varchar(10),
  activity_type      varchar(6),
  item_text          varchar(60),
  quantity           numeric(23,3) not null,
  unit               varchar(6),
  price              numeric(23,4) not null,
  price_unit         numeric(23,3) not null,
  price_source       varchar(14) not null,
  amount             numeric(23,4) not null,
  -- false for a line that only explains a rolled-up line above it (a made component's own lines).
  in_total           boolean     not null,
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  primary key (client, material_number, plant, costing_date, costing_version, line_number),
  constraint material_cost_estimate_item_header_fk foreign key (client, material_number, plant, costing_date, costing_version)
    references public.material_cost_estimate (client, material_number, plant, costing_date, costing_version) on delete cascade,
  constraint material_cost_estimate_item_type_ck check (item_type in ('MATERIAL','ACTIVITY')),
  constraint material_cost_estimate_item_source_ck check (price_source in ('STANDARD','MOVING_AVERAGE','COSTED','ACTIVITY_PLAN','NOT_COSTED')),
  constraint material_cost_estimate_item_level_ck check (level >= 0),
  constraint material_cost_estimate_item_unit_ck check (price_unit > 0)
);

do $$
declare
  t text;
begin
  foreach t in array array['material_cost_estimate','material_cost_estimate_item'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
-- An estimate is written once; only its status changes. Never deleted.
grant select, insert, update on table public.material_cost_estimate to cairn_app;
grant select, insert on table public.material_cost_estimate_item to cairn_app;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PROD.COST.ESTIMATE.CREATE', 'PROD', 'CREATE', false,
   'Create and display a standard cost estimate for a material (CK11N / CK13N). Writes no price and posts nothing')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9288a000-0000-4000-8000-000000000001', 'PROD.COST.ESTIMATE.CREATE', 'material_cost_estimate', 'Standard cost estimate',
       'TRANSACTION', 'PROD',
       'Cost one material in one plant on a costing date: multi-level BOM costed bottom-up, routing operations at plan activity prices, '
       || 'saved with its itemization. No overhead (no costing sheet). Never writes a price; release is a later step.',
       'TIER_1_BUILT', '/production/cost-estimate', 'B', null, true, 'MIGRATION_9288', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9288a000-0000-4000-8000-000000000001' or r.our_code = 'PROD.COST.ESTIMATE.CREATE');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9288a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9288', now()
  from (values
    ('9288b000-0000-4000-8000-000000000001', 'CK11N'),
    ('9288b000-0000-4000-8000-000000000002', 'CK13N')
  ) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9288a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);
