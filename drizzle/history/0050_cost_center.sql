-- SCR-041 / R-90 (stage 2): the cost centre periods (KS01).
--
-- A cost centre is where cost accounting collects overhead. Its master
-- data rests on validity periods keyed (controlling area, cost centre,
-- valid from): several non-overlapping periods per centre, each carrying
-- its own facts — the reference layout's key, in product vocabulary.
-- The company code must stand assigned to the area, judged at the
-- database by the foreign key onto the area-company assignment itself;
-- the currency lives on the controlling area and is never stored twice.
-- Period overlap cannot be a check (it reads sibling rows), so the
-- service judges it; formats, the category vocabulary and the validity
-- span are declared here so the database agrees with the service.
create table public.cost_center (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  cost_center varchar(10) not null,
  valid_from date not null,
  valid_to date not null,
  name varchar(40) not null,
  person_responsible varchar(20),
  category varchar(16) not null,
  company_code varchar(10) not null,
  is_posting_locked boolean not null default false,
  created_by varchar(64) not null default 'system',
  created_at timestamptz not null default now(),
  primary key (client, controlling_area, cost_center, valid_from),
  constraint cost_center_controlling_area_format_ck check (controlling_area ~ '^[A-Z0-9]{4}$'),
  constraint cost_center_code_format_ck check (cost_center ~ '^[A-Z0-9]{1,10}$'),
  constraint cost_center_name_not_blank_ck check (length(btrim(name)) > 0),
  constraint cost_center_person_not_blank_ck check (person_responsible is null or length(btrim(person_responsible)) > 0),
  constraint cost_center_category_ck check (category in ('PRODUCTION','ADMINISTRATION','SERVICE','SALES','SUPPORT')),
  constraint cost_center_company_code_format_ck check (company_code ~ '^[A-Z0-9]{1,10}$'),
  constraint cost_center_validity_ck check (valid_to >= valid_from),
  constraint cost_center_controlling_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area),
  constraint cost_center_area_company_fk foreign key (client, controlling_area, company_code)
    references public.controlling_area_company (client, controlling_area, company_code)
);
--> statement-breakpoint
