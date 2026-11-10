-- SCR-043 / R-92 (stage 2): the activity type periods (KL01).
--
-- An activity type is the measurable output a cost centre performs.
-- Its master rests on validity periods keyed (controlling area,
-- activity type, valid from) — the KS01 period shape (SAP parity): the
-- two behaviour fields stored as the reference's digits (category 1–4,
-- price indicator 1–3), the activity unit judged against the global
-- unit_of_measure table at write time, and the KS01 cost-centre
-- categories the type is valid for as a canonical subset ('' = all).
-- Period overlap reads sibling rows, so the service judges it; formats
-- and the digit vocabularies are declared here so the database agrees
-- with the service.
create table public.activity_type (
  client varchar(4) not null references public.client(client) on delete cascade,
  controlling_area varchar(4) not null,
  activity_type varchar(6) not null,
  valid_from date not null,
  valid_to date not null,
  name varchar(40) not null,
  activity_unit varchar(6) not null,
  category char(1) not null,
  price_indicator char(1) not null,
  valid_cc_categories varchar(80) not null default '',
  is_posting_locked boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, controlling_area, activity_type, valid_from),
  constraint activity_type_area_format_ck check (controlling_area ~ '^[A-Z0-9]{4}$'),
  constraint activity_type_code_format_ck check (activity_type ~ '^[A-Z0-9]{1,6}$'),
  constraint activity_type_name_not_blank_ck check (length(btrim(name)) > 0),
  constraint activity_type_category_ck check (category in ('1','2','3','4')),
  constraint activity_type_price_indicator_ck check (price_indicator in ('1','2','3')),
  constraint activity_type_validity_ck check (valid_to >= valid_from),
  constraint activity_type_area_fk foreign key (client, controlling_area)
    references public.controlling_area (client, controlling_area)
);
--> statement-breakpoint
