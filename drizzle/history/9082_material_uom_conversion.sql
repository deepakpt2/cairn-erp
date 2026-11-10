-- SCR-144 (B-915/§26.927): the conversion the entry unit never had.
--
-- canon carried unit_of_measure (dimension, decimal_places), material.base_unit — and nothing
-- between them, so every posting stored entry_quantity = base_quantity and the entry unit was
-- decorative. This table states one alternative unit per material per base unit as an exact
-- ratio, so conversion is rational arithmetic rather than a float multiplier:
--
--   base_quantity = entry_quantity * numerator / denominator
--
-- One row per (material, alternative unit): a second row would be a second answer to "how many
-- base units is one CASE", which is exactly the drift this book refuses.
create table if not exists public.material_uom_conversion (
  client varchar(4) not null references public.client (client) on delete cascade,
  material_number varchar(40) not null,
  alternative_unit varchar(6) not null,
  base_unit varchar(6) not null,
  numerator integer not null,
  denominator integer not null,
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint material_uom_conversion_pk
    primary key (client, material_number, alternative_unit),
  constraint material_uom_conversion_material_fk
    foreign key (client, material_number)
    references public.material (client, material_number) on delete cascade,
  constraint material_uom_conversion_ratio_ck
    check (numerator > 0 and denominator > 0),
  -- A unit cannot convert to itself: that is not a conversion, it is the base unit.
  constraint material_uom_conversion_distinct_ck
    check (alternative_unit <> base_unit)
);

create index if not exists material_uom_conversion_material_idx
  on public.material_uom_conversion (client, material_number);
