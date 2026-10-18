-- SCR-054 / R-102 (stage 2): material period control (OMSY).
--
-- One control record per company code: the current and previous
-- material posting periods, the previous-year reference set at a
-- year-boundary shift, and the two backposting indicators kept
-- separate. Initialized once through the screen's privileged act and
-- afterwards advanced only by the shift; never deleted. Periods are
-- judged in the service against the company's fiscal-year variant
-- (regular periods only — special periods are never material periods).
create table public.material_period_control (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  current_fiscal_year integer not null,
  current_period smallint not null,
  previous_fiscal_year integer not null,
  previous_period smallint not null,
  previous_year_ref_year integer,
  previous_year_ref_period smallint,
  allow_backposting boolean not null default false,
  disallow_backposting_after_change boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, company_code),
  foreign key (client, company_code) references public.company_code (client, company_code) on delete cascade,
  constraint material_period_control_current_ck check (current_period between 1 and 16),
  constraint material_period_control_previous_ck check (previous_period between 1 and 16),
  constraint material_period_control_year_ck check (current_fiscal_year between 1000 and 9999 and previous_fiscal_year between 1000 and 9999),
  constraint material_period_control_ref_ck check (previous_year_ref_period is null or previous_year_ref_period between 1 and 16)
);
