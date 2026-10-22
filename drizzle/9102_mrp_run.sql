-- SCR-166 — total planning (MD01).
--
-- A run records what was planned. It is not stock, and it is not a requisition.
-- The planning file remains the net-change marker. A planned order is a proposal,
-- not a production order. There is no second requisition table and no bill of material.

alter table public.purchase_requisition_item
  add column if not exists planning_run_number varchar(12);

create unique index if not exists pr_item_planning_origin_uq
  on public.purchase_requisition_item (client, planning_run_number, material_number, plant)
  where planning_run_number is not null;

create table if not exists public.planned_order (
  client varchar(4) not null references public.client (client) on delete cascade,
  order_number varchar(12) not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  quantity numeric(23, 3) not null,
  unit varchar(6) not null,
  start_date date not null,
  finish_date date not null,
  firming_status varchar(8) not null default 'OPEN',
  origin varchar(8) not null default 'MRP',
  request_key varchar(64) not null,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint planned_order_pk primary key (client, order_number),
  constraint planned_order_request_uq unique (client, request_key),
  constraint planned_order_material_fk
    foreign key (client, material_number) references public.material (client, material_number),
  constraint planned_order_plant_fk
    foreign key (client, plant) references public.plant (client, plant),
  constraint planned_order_quantity_ck check (quantity > 0),
  constraint planned_order_dates_ck check (finish_date >= start_date),
  constraint planned_order_firming_ck check (firming_status in ('OPEN', 'FIRMED')),
  constraint planned_order_origin_ck check (origin in ('MRP')),
  constraint planned_order_version_ck check (version > 0)
);

create index if not exists planned_order_material_idx
  on public.planned_order (client, material_number, plant);

create table if not exists public.mrp_run (
  client varchar(4) not null references public.client (client) on delete cascade,
  run_number varchar(12) not null,
  processing_key varchar(8) not null,
  execution_mode varchar(16) not null default 'FOREGROUND',
  planning_mode varchar(24) not null default 'ADAPT_EXISTING',
  simulation_only boolean not null default false,
  plant_from varchar(10) not null,
  plant_to varchar(10) not null,
  material_from varchar(40),
  material_to varchar(40),
  mrp_controller varchar(3),
  horizon_start date,
  horizon_end date,
  status varchar(32) not null default 'QUEUED',
  request_key varchar(64) not null,
  requested_by varchar(60) not null,
  materials_selected integer not null default 0,
  materials_planned integer not null default 0,
  materials_skipped integer not null default 0,
  materials_failed integer not null default 0,
  proposals_created integer not null default 0,
  proposals_changed integer not null default 0,
  proposals_retained integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  error_summary varchar(200),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint mrp_run_pk primary key (client, run_number),
  constraint mrp_run_request_uq unique (client, request_key),
  constraint mrp_run_key_ck check (processing_key in ('NETCH', 'NETPL', 'NEUPL')),
  constraint mrp_run_execution_ck check (execution_mode in ('FOREGROUND')),
  constraint mrp_run_mode_ck check (planning_mode in ('ADAPT_EXISTING')),
  constraint mrp_run_status_ck check (status in (
    'QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLING', 'CANCELLED'
  )),
  constraint mrp_run_plants_ck check (plant_from <= plant_to),
  constraint mrp_run_materials_ck check (
    (material_from is null and material_to is null) or (material_from is not null and material_to is not null and material_from <= material_to)
  ),
  constraint mrp_run_horizon_ck check (
    (horizon_start is null and horizon_end is null) or (horizon_start is not null and horizon_end is not null and horizon_start <= horizon_end)
  ),
  constraint mrp_run_counts_ck check (
    materials_selected >= 0 and materials_planned >= 0 and materials_skipped >= 0 and materials_failed >= 0
    and proposals_created >= 0 and proposals_changed >= 0 and proposals_retained >= 0
  )
);

create index if not exists mrp_run_status_idx
  on public.mrp_run (client, status, created_at);

create table if not exists public.mrp_run_material (
  client varchar(4) not null references public.client (client) on delete cascade,
  run_number varchar(12) not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  status varchar(16) not null default 'PENDING',
  supply_quantity numeric(23, 3) not null default 0,
  demand_quantity numeric(23, 3) not null default 0,
  shortage_quantity numeric(23, 3) not null default 0,
  proposals_created integer not null default 0,
  proposals_changed integer not null default 0,
  proposals_retained integer not null default 0,
  diagnostic_code varchar(40),
  message varchar(200),
  planning_changed_at timestamptz,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint mrp_run_material_pk primary key (client, run_number, material_number, plant),
  constraint mrp_run_material_run_fk
    foreign key (client, run_number) references public.mrp_run (client, run_number) on delete cascade,
  constraint mrp_run_material_status_ck check (status in ('PENDING', 'RUNNING', 'COMPLETED', 'SKIPPED', 'FAILED', 'CANCELLED')),
  constraint mrp_run_material_qty_ck check (supply_quantity >= 0 and demand_quantity >= 0 and shortage_quantity >= 0)
);

create table if not exists public.mrp_run_proposal (
  client varchar(4) not null references public.client (client) on delete cascade,
  run_number varchar(12) not null,
  line_number integer not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  proposal_type varchar(24) not null,
  action varchar(12) not null,
  document_number varchar(12),
  item_number integer,
  quantity numeric(23, 3) not null,
  unit varchar(6) not null,
  receipt_date date not null,
  start_date date not null,
  status varchar(12) not null,
  reason varchar(200) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  constraint mrp_run_proposal_pk primary key (client, run_number, line_number),
  constraint mrp_run_proposal_run_fk
    foreign key (client, run_number) references public.mrp_run (client, run_number) on delete cascade,
  constraint mrp_run_proposal_type_ck check (proposal_type in ('PURCHASE_REQUISITION', 'PLANNED_ORDER')),
  constraint mrp_run_proposal_action_ck check (action in ('CREATE', 'UPDATE', 'RETAIN', 'NO_CHANGE', 'CONFLICT')),
  constraint mrp_run_proposal_status_ck check (status in ('PROPOSED', 'APPLIED', 'CONFLICT')),
  constraint mrp_run_proposal_qty_ck check (quantity > 0),
  constraint mrp_run_proposal_line_ck check (line_number > 0)
);

create index if not exists mrp_run_proposal_document_idx
  on public.mrp_run_proposal (client, document_number);

create table if not exists public.mrp_run_diagnostic (
  client varchar(4) not null references public.client (client) on delete cascade,
  run_number varchar(12) not null,
  line_number integer not null,
  material_number varchar(40),
  plant varchar(10),
  severity varchar(8) not null,
  diagnostic_code varchar(40) not null,
  message varchar(200) not null,
  created_at timestamptz not null default now(),
  constraint mrp_run_diagnostic_pk primary key (client, run_number, line_number),
  constraint mrp_run_diagnostic_run_fk
    foreign key (client, run_number) references public.mrp_run (client, run_number) on delete cascade,
  constraint mrp_run_diagnostic_severity_ck check (severity in ('INFO', 'WARNING', 'ERROR')),
  constraint mrp_run_diagnostic_line_ck check (line_number > 0)
);

create index if not exists mrp_run_diagnostic_code_idx
  on public.mrp_run_diagnostic (client, run_number, diagnostic_code);

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'MRPRUN', 'MRP runs', 7, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o where o.client = c.client and o.object_code = 'MRPRUN'
 );

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'PLANORD', 'Planned orders', 7, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o where o.client = c.client and o.object_code = 'PLANORD'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'MRPRUN', '*', '*', 0, 'MR', 1, 999999, 0, 7, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'MRPRUN' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'PLANORD', '*', '*', 0, 'PL', 1, 999999, 0, 7, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'PLANORD' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

alter table public.planned_order enable row level security;
alter table public.planned_order force row level security;
create policy tenant_isolation on public.planned_order
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.planned_order from public;
grant select, insert, update on public.planned_order to cairn_app;

alter table public.mrp_run enable row level security;
alter table public.mrp_run force row level security;
create policy tenant_isolation on public.mrp_run
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.mrp_run from public;
grant select, insert, update on public.mrp_run to cairn_app;

alter table public.mrp_run_material enable row level security;
alter table public.mrp_run_material force row level security;
create policy tenant_isolation on public.mrp_run_material
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.mrp_run_material from public;
grant select, insert, update on public.mrp_run_material to cairn_app;

alter table public.mrp_run_proposal enable row level security;
alter table public.mrp_run_proposal force row level security;
create policy tenant_isolation on public.mrp_run_proposal
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.mrp_run_proposal from public;
grant select, insert, update on public.mrp_run_proposal to cairn_app;

alter table public.mrp_run_diagnostic enable row level security;
alter table public.mrp_run_diagnostic force row level security;
create policy tenant_isolation on public.mrp_run_diagnostic
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.mrp_run_diagnostic from public;
grant select, insert, update on public.mrp_run_diagnostic to cairn_app;
