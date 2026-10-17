-- SCR-045 / R-94 (stage 2): the profit centre periods (KE51).
--
-- A profit centre is the unit profitability is reported on. Its master
-- rests on validity periods keyed (controlling area, profit centre,
-- valid from) — the KS01 period shape (SAP parity): the short name at
-- most 20 characters required and the long text at most 40 optional,
-- both on the row as every master here keeps its name; the segment at
-- parity width, entered freely until a segment master stands; and no
-- hierarchy field — placement is deferred to the profit centre
-- hierarchy SCR, exactly as KS01's was. Period overlap reads sibling
-- rows, so the service judges it; formats and the span are declared
-- here so the database agrees with the service.
create table public.profit_center (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  profit_center varchar(10) not null,
  valid_from date not null,
  valid_to date not null,
  name varchar(20) not null,
  long_text varchar(40),
  person_responsible varchar(20) not null default '',
  responsible_user varchar(12),
  segment varchar(10),
  is_posting_locked boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, profit_center, valid_from),
  constraint profit_center_area_format_ck check (controlling_area ~ '^[A-Z0-9]{4}$'),
  constraint profit_center_code_format_ck check (profit_center ~ '^[A-Z0-9]{1,10}$'),
  constraint profit_center_name_not_blank_ck check (length(btrim(name)) > 0),
  constraint profit_center_validity_ck check (valid_to >= valid_from),
  constraint profit_center_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area)
);
--> statement-breakpoint
