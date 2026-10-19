-- SCR-112 / R-160 (stage 2): cost-element plan values, the one
-- canon table the actual/plan report was missing (KP06-style
-- primary-cost planning, minimal). Actuals keep deriving from
-- the journal; this table only ever holds planned amounts.
-- Versions share the standing plan-version vocabulary ('000').
create table public.cost_center_plan (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  plan_version varchar(3) not null default '000',
  fiscal_year integer not null,
  period smallint not null,
  cost_center varchar(10) not null,
  cost_element varchar(10) not null,
  planned_amount numeric(23, 4) not null,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, controlling_area, plan_version, fiscal_year, period, cost_center, cost_element),
  foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area) on delete cascade,
  check (period between 1 and 16),
  check (plan_version ~ '^[A-Z0-9]{1,3}$')
);
