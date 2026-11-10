-- SCR-133 (B-861/§26.873): reservations (MB21) — the RKPF and RESB shapes.
--
-- A reservation is the one inventory document that stores something nobody has
-- posted: a planned withdrawal. It carries the movement type that will withdraw
-- it, the required date it demands stock on, and the account assignment that
-- movement charges. The plant stands on the item, as SAP's RESB-WERKS does.
--
-- The movement catalogue learns two facts it never carried: the ISSUE direction
-- (a reservation's future issue) and the account-assignment category each
-- movement demands (T156).

create table if not exists public.reservation_header (
  client varchar(4) not null references public.client (client) on delete cascade,
  reservation_number varchar(10) not null,
  movement_type varchar(20) not null,
  base_date varchar(10) not null,
  cost_center varchar(10),
  controlling_area varchar(4),
  order_number varchar(12),
  request_key varchar(64),
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint reservation_header_pk primary key (client, reservation_number),
  constraint reservation_header_movement_fk foreign key (client, movement_type)
    references public.movement_type (client, movement_type) on delete restrict
);

create table if not exists public.reservation_item (
  client varchar(4) not null references public.client (client) on delete cascade,
  reservation_number varchar(10) not null,
  item_number integer not null,
  material_number varchar(40) not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  required_quantity numeric(23, 3) not null,
  withdrawn_quantity numeric(23, 3) not null default 0,
  unit_of_measure varchar(10) not null,
  movement_allowed boolean not null default true,
  is_completed boolean not null default false,
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint reservation_item_pk primary key (client, reservation_number, item_number),
  constraint reservation_item_header_fk foreign key (client, reservation_number)
    references public.reservation_header (client, reservation_number) on delete cascade,
  constraint reservation_item_quantity_ck check (required_quantity > 0 and withdrawn_quantity >= 0)
);

alter table public.movement_type
  add column if not exists account_assignment varchar(16) not null default 'NONE';

alter table public.movement_type drop constraint if exists movement_type_direction_ck;
alter table public.movement_type add constraint movement_type_direction_ck
  check (direction in ('RECEIPT', 'REVERSAL', 'TRANSFER', 'ISSUE'));

alter table public.movement_type drop constraint if exists movement_type_reference_ck;
alter table public.movement_type add constraint movement_type_reference_ck
  check (reference_category in ('PURCHASE_ORDER', 'MATERIAL_DOCUMENT', 'RESERVATION'));

alter table public.movement_type drop constraint if exists movement_type_account_assignment_ck;
alter table public.movement_type add constraint movement_type_account_assignment_ck
  check (account_assignment in ('NONE', 'COST_CENTER', 'ORDER'));
