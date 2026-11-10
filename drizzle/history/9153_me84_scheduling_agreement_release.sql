-- ME84 creates a supplier-facing scheduling agreement release.
-- It does not post, and it does not notify the supplier.
-- LP stays without release documentation. LPA is configured data, not a hardcoded meaning.
-- No release profile is seeded. A missing profile is a skip, not a default horizon.
-- Journal lines, schedule lines, purchase orders, and goods receipts are not changed.

alter table public.scheduling_agreement_type
  add column release_documentation boolean not null default false;

alter table public.scheduling_agreement_item
  add column jit_enabled boolean not null default false;

alter table public.material_plant
  add column jit_delivery_schedule boolean not null default false;

create table public.scheduling_release_profile (
  client varchar(4) not null references public.client (client) on delete cascade,
  profile_code varchar(10) not null,
  description varchar(40) not null,
  release_type varchar(3) not null,
  horizon_days integer,
  aggregation varchar(8) not null,
  comparison_mode varchar(8) not null,
  tolerance_percent numeric(5, 2),
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, profile_code),
  constraint scheduling_release_profile_code_ck check (profile_code ~ '^[A-Z0-9]{2,10}$'),
  constraint scheduling_release_profile_type_ck check (release_type in ('FRC', 'JIT')),
  constraint scheduling_release_profile_aggregation_ck check (aggregation in ('NONE', 'DAY', 'WEEK', 'MONTH')),
  constraint scheduling_release_profile_comparison_ck check (comparison_mode in ('LINE', 'OVERALL')),
  constraint scheduling_release_profile_horizon_ck check (horizon_days is null or (horizon_days >= 0 and horizon_days <= 999)),
  constraint scheduling_release_profile_tolerance_ck check (tolerance_percent is null or (tolerance_percent >= 0 and tolerance_percent <= 999.99)),
  constraint scheduling_release_profile_description_ck check (char_length(btrim(description)) between 1 and 40)
);

alter table public.scheduling_release_profile enable row level security;
alter table public.scheduling_release_profile force row level security;
create policy tenant_isolation on public.scheduling_release_profile
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_release_profile from public;
grant select, insert, update, delete on public.scheduling_release_profile to cairn_app;

create table public.scheduling_release_profile_assignment (
  client varchar(4) not null references public.client (client) on delete cascade,
  supplier_number varchar(40) not null,
  purchasing_org varchar(10) not null,
  plant varchar(10) not null default '',
  release_type varchar(3) not null,
  profile_code varchar(10) not null,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, supplier_number, purchasing_org, plant, release_type),
  constraint scheduling_release_profile_assignment_type_ck check (release_type in ('FRC', 'JIT')),
  constraint scheduling_release_profile_assignment_profile_fk
    foreign key (client, profile_code)
    references public.scheduling_release_profile (client, profile_code)
);

alter table public.scheduling_release_profile_assignment enable row level security;
alter table public.scheduling_release_profile_assignment force row level security;
create policy tenant_isolation on public.scheduling_release_profile_assignment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_release_profile_assignment from public;
grant select, insert, update, delete on public.scheduling_release_profile_assignment to cairn_app;

create table public.scheduling_agreement_release (
  client varchar(4) not null references public.client (client) on delete cascade,
  release_number varchar(20) not null,
  agreement_number varchar(20) not null,
  item_number integer not null,
  release_type varchar(3) not null,
  profile_code varchar(10) not null,
  aggregation varchar(8) not null,
  comparison_mode varchar(8) not null,
  horizon_days integer,
  tolerance_percent numeric(5, 2),
  generation_date date not null,
  released_quantity numeric(13, 3) not null,
  transmission_status varchar(20) not null default 'NOT_TRANSMITTED',
  transmission_detail varchar(200) not null,
  request_key varchar(120),
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, release_number),
  constraint scheduling_agreement_release_type_ck check (release_type in ('FRC', 'JIT')),
  constraint scheduling_agreement_release_aggregation_ck check (aggregation in ('NONE', 'DAY', 'WEEK', 'MONTH')),
  constraint scheduling_agreement_release_comparison_ck check (comparison_mode in ('LINE', 'OVERALL')),
  constraint scheduling_agreement_release_transmission_ck check (transmission_status = 'NOT_TRANSMITTED'),
  constraint scheduling_agreement_release_quantity_ck check (released_quantity > 0)
);

create unique index scheduling_agreement_release_request_key_uq
  on public.scheduling_agreement_release (client, request_key)
  where request_key is not null;

alter table public.scheduling_agreement_release enable row level security;
alter table public.scheduling_agreement_release force row level security;
create policy tenant_isolation on public.scheduling_agreement_release
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_agreement_release from public;
grant select, insert, update, delete on public.scheduling_agreement_release to cairn_app;

create table public.scheduling_agreement_release_line (
  client varchar(4) not null references public.client (client) on delete cascade,
  release_number varchar(20) not null,
  line_number integer not null,
  delivery_date date not null,
  quantity numeric(13, 3) not null,
  unit varchar(6) not null,
  created_by varchar(60) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, release_number, line_number),
  constraint scheduling_agreement_release_line_release_fk
    foreign key (client, release_number)
    references public.scheduling_agreement_release (client, release_number) on delete cascade,
  constraint scheduling_agreement_release_line_quantity_ck check (quantity > 0),
  constraint scheduling_agreement_release_line_number_ck check (line_number > 0)
);

alter table public.scheduling_agreement_release_line enable row level security;
alter table public.scheduling_agreement_release_line force row level security;
create policy tenant_isolation on public.scheduling_agreement_release_line
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.scheduling_agreement_release_line from public;
grant select, insert, update, delete on public.scheduling_agreement_release_line to cairn_app;

insert into public.number_range_object (client, object_code, description, number_length, year_relevant, created_by)
select c.client, 'SARELEASE', 'Scheduling agreement releases', 10, false, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range_object o
    where o.client = c.client and o.object_code = 'SARELEASE'
 );

insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, created_by
)
select c.client, 'SARELEASE', '*', '*', 0, '56', 1, 999999, 0, 10, 'READABLE', 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.number_range r
    where r.client = c.client and r.object_code = 'SARELEASE' and r.company_code = '*'
      and r.sub_object = '*' and r.fiscal_year = 0
 );

insert into public.scheduling_agreement_type (
  client, document_type, description, category, number_range_sub_object, item_interval,
  release_documentation, created_by
)
select c.client, 'LPA', 'Release documentation', 'SCHEDULING', '*', 10, true, 'SYSTEM'
  from public.client c
 where not exists (
   select 1 from public.scheduling_agreement_type t
    where t.client = c.client and t.document_type = 'LPA'
 );

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'PROC.SARELEASE.CREATE', 'PROC', 'CREATE', false,
  'Create scheduling agreement releases. ME84 does not post and does not notify the supplier.'
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
values (
  gen_random_uuid()::text, 'PROC.SARELEASE.CREATE', 'scheduling_agreement_release', 'Scheduling agreement release',
  'TRANSACTION', 'PROC',
  'Create scheduling agreement releases from delivery schedule lines. ME84 is a search alias. Saving does not post, and it does not notify the supplier.',
  'TIER_1_BUILT', '/purchasing/scheduling-agreement-releases', 'B', 'MIGRATION_9153'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9153',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'ME84', 'SEARCH_ONLY', 'MIGRATION_9153'
  from term_registry t
 where t.our_code = 'PROC.SARELEASE.CREATE'
on conflict (external_system, alias) do nothing;
