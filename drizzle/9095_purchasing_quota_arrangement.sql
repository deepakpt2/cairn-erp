-- SCR-154 — the purchasing quota arrangement.
--
-- An arrangement weights who may supply one material at one plant over an
-- inclusive validity. It is not a source list, not an info record, not an
-- order, and not MRP. The header key is the drawn number. The lookup is the
-- material and the plant. There is no allocated-quantity column, no minimum
-- split, no maximum lot, no supplying plant, no status, no company code, and
-- no request key. The name carries no transaction alias.
--
-- A second standing arrangement with the same start is refused here. A
-- different start may overlap in the database. The locked service refuses that
-- overlap. A deactivated arrangement does not hold the start. There is no
-- exclusion constraint. The order is not given a quota column.
--
-- The lookup the preview will run — arrangements for one material and plant
-- whose validity contains the date — is measured after this migration is
-- applied. No further index is added until that measurement says these keys
-- are not enough.

create table if not exists public.purchasing_quota_arrangement (
  client varchar(4) not null references public.client (client) on delete cascade,
  quota_number varchar(20) not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  valid_from date not null,
  valid_to date not null,
  marked_for_deletion boolean not null default false,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_quota_arrangement_pk primary key (client, quota_number),
  constraint purchasing_quota_arrangement_material_fk
    foreign key (client, material_number)
    references public.material (client, material_number)
    on delete restrict,
  constraint purchasing_quota_arrangement_plant_fk
    foreign key (client, plant)
    references public.plant (client, plant)
    on delete restrict,
  constraint purchasing_quota_arrangement_version_ck check (version > 0),
  constraint purchasing_quota_arrangement_number_ck check (char_length(btrim(quota_number)) between 1 and 20),
  constraint purchasing_quota_arrangement_validity_ck check (valid_to >= valid_from)
);

create table if not exists public.purchasing_quota_arrangement_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  quota_number varchar(20) not null,
  item_number varchar(3) not null,
  partner_number varchar(40) not null,
  role_code varchar(16) not null default 'SUPPLIER',
  purchasing_org varchar(10) not null,
  quota integer not null,
  quota_base_quantity numeric(23, 3) not null default 0,
  marked_for_deletion boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_quota_arrangement_item_pk primary key (client, quota_number, item_number),
  constraint purchasing_quota_arrangement_item_header_fk
    foreign key (client, quota_number)
    references public.purchasing_quota_arrangement (client, quota_number)
    on delete restrict,
  constraint purchasing_quota_arrangement_item_supplier_fk
    foreign key (client, partner_number, role_code)
    references public.bp_role (client, partner_number, role_code)
    on delete restrict,
  constraint purchasing_quota_arrangement_item_org_fk
    foreign key (client, purchasing_org)
    references public.purchasing_org (client, purchasing_org)
    on delete restrict,
  constraint purchasing_quota_arrangement_item_role_ck check (role_code = 'SUPPLIER'),
  constraint purchasing_quota_arrangement_item_number_ck check (item_number ~ '^[0-9]{3}$'),
  constraint purchasing_quota_arrangement_item_quota_ck check (quota > 0),
  constraint purchasing_quota_arrangement_item_base_ck check (quota_base_quantity >= 0)
);

-- One supplier in one organisation, once. Deactivation does not free the item.
create unique index if not exists purchasing_quota_item_supplier_uq
  on public.purchasing_quota_arrangement_item (client, quota_number, purchasing_org, partner_number);

-- A standing arrangement holds its start. A deactivated row does not.
create unique index if not exists purchasing_quota_arrangement_standing_start_uq
  on public.purchasing_quota_arrangement (client, material_number, plant, valid_from)
  where marked_for_deletion = false;

-- The preview lookup is the material and the plant, then the dates.
create index if not exists purchasing_quota_arrangement_material_plant_idx
  on public.purchasing_quota_arrangement (client, material_number, plant, valid_from, valid_to);

alter table public.purchasing_quota_arrangement enable row level security;
alter table public.purchasing_quota_arrangement force row level security;
create policy tenant_isolation on public.purchasing_quota_arrangement
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_quota_arrangement from public;
grant select, insert, update, delete on public.purchasing_quota_arrangement to cairn_app;

alter table public.purchasing_quota_arrangement_item enable row level security;
alter table public.purchasing_quota_arrangement_item force row level security;
create policy tenant_isolation on public.purchasing_quota_arrangement_item
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_quota_arrangement_item from public;
grant select, insert, update, delete on public.purchasing_quota_arrangement_item to cairn_app;
