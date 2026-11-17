-- FOUND-02: global unit conversion factors . unit_of_measure is global: no client, no RLS.
alter table public.unit_of_measure
  add column numerator   integer not null default 1,
  add column denominator integer not null default 1,
  add column exponent    integer not null default 0;

alter table public.unit_of_measure
  add constraint unit_of_measure_factor_ck
  check (numerator > 0 and denominator > 0 and exponent between -30 and 30);

-- TIME only. The dimension's base unit here is HR (not the spec's S): factors are relative to it.
update public.unit_of_measure set numerator = 1, denominator = 1,  exponent = 0 where code = 'HR'  and dimension = 'TIME' and is_base_unit;
update public.unit_of_measure set numerator = 1, denominator = 60, exponent = 0 where code = 'MIN' and dimension = 'TIME';
update public.unit_of_measure set numerator = 24, denominator = 1, exponent = 0 where code = 'DAY' and dimension = 'TIME';
