-- SCR-153 — the purchasing source list.
--
-- A list names who may supply one material at one plant. It is not an info record,
-- not a requisition, and not an order. The header is the material and the plant.
-- The requirement flag defaults off: creating the first entry does not turn
-- enforcement on. An entry is one supplier in one purchasing organisation for an
-- inclusive validity. There is no agreement column, no price, no company code,
-- and no request key. The name carries no transaction alias.
--
-- Overlap of a different start, and two fixed entries over the same dates, are
-- refused by the locked service, not by an exclusion constraint. The database
-- carries no range type for this. The unique start index stops a second entry
-- with the same supplier, organisation and start.
--
-- The lookup the order will run — the list by material and plant, then the
-- entries whose validity contains the document date — is measured after this
-- migration is applied. No further index is added until that measurement says
-- the unique keys are not enough.

create table if not exists public.purchasing_source_list (
  client varchar(4) not null references public.client (client) on delete cascade,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  source_list_required boolean not null default false,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_source_list_pk primary key (client, material_number, plant),
  constraint purchasing_source_list_material_fk
    foreign key (client, material_number)
    references public.material (client, material_number)
    on delete restrict,
  constraint purchasing_source_list_plant_fk
    foreign key (client, plant)
    references public.plant (client, plant)
    on delete restrict,
  constraint purchasing_source_list_version_ck check (version > 0)
);

create table if not exists public.purchasing_source_list_entry (
  client varchar(4) not null references public.client (client) on delete cascade,
  source_number varchar(20) not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  partner_number varchar(40) not null,
  role_code varchar(16) not null default 'SUPPLIER',
  purchasing_org varchar(10) not null,
  valid_from date not null,
  valid_to date not null,
  fixed_source boolean not null default false,
  blocked_source boolean not null default false,
  mrp_relevant boolean not null default false,
  marked_for_deletion boolean not null default false,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint purchasing_source_list_entry_pk primary key (client, source_number),
  constraint purchasing_source_list_entry_list_fk
    foreign key (client, material_number, plant)
    references public.purchasing_source_list (client, material_number, plant)
    on delete restrict,
  constraint purchasing_source_list_entry_supplier_fk
    foreign key (client, partner_number, role_code)
    references public.bp_role (client, partner_number, role_code)
    on delete restrict,
  constraint purchasing_source_list_entry_org_fk
    foreign key (client, purchasing_org)
    references public.purchasing_org (client, purchasing_org)
    on delete restrict,
  constraint purchasing_source_list_entry_role_ck check (role_code = 'SUPPLIER'),
  constraint purchasing_source_list_entry_version_ck check (version > 0),
  constraint purchasing_source_list_entry_number_ck check (char_length(btrim(source_number)) between 1 and 20),
  constraint purchasing_source_list_entry_validity_ck check (valid_to >= valid_from)
);

-- One entry per supplier, organisation and start. A later start is another row.
create unique index if not exists purchasing_source_list_entry_start_uq
  on public.purchasing_source_list_entry (client, material_number, plant, purchasing_org, partner_number, valid_from);

-- The order keeps a reference to the source it qualified. The supplier on the
-- order remains the snapshot. Deleting the entry does not take the order with it.
alter table public.purchase_order_item
  add column if not exists source_number varchar(20);

alter table public.purchase_order_item
  add constraint purchase_order_item_source_fk
  foreign key (client, source_number)
  references public.purchasing_source_list_entry (client, source_number)
  on delete restrict;

alter table public.purchasing_source_list enable row level security;
alter table public.purchasing_source_list force row level security;
create policy tenant_isolation on public.purchasing_source_list
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_source_list from public;
grant select, insert, update, delete on public.purchasing_source_list to cairn_app;

alter table public.purchasing_source_list_entry enable row level security;
alter table public.purchasing_source_list_entry force row level security;
create policy tenant_isolation on public.purchasing_source_list_entry
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.purchasing_source_list_entry from public;
grant select, insert, update, delete on public.purchasing_source_list_entry to cairn_app;
