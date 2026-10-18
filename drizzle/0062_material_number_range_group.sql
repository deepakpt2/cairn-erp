-- SCR-051 / R-99 (stage 2): material number range groups (MMNR).
--
-- A group is a named pair of MATERIALNR intervals: one internal range
-- key and one external range key, the pair itself being the group's
-- identity (TNRGT parity). Material types carry the same two keys
-- (SCR-048), so assignment is derived from the pair and never stored
-- twice. Intervals themselves stay in number_range; nothing about the
-- standing engine changes here.
create table public.material_number_range_group (
  client varchar(4) not null references public.client(client) on delete cascade,
  internal_range_key varchar(2) not null,
  external_range_key varchar(2) not null,
  description varchar(20) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, internal_range_key, external_range_key),
  constraint material_number_range_group_internal_ck check (internal_range_key ~ '^[A-Z0-9]{2}$'),
  constraint material_number_range_group_external_ck check (external_range_key ~ '^[A-Z0-9]{2}$')
);
