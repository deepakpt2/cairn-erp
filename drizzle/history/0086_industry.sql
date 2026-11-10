-- SCR-077 / R-125 (stage 2): the industry master a business partner
-- classifies under (OB44 shape), with descriptions per language.
--
-- The code stands alone on `industry` (at most four uppercase letters
-- or digits, never renamed); `industry_text` carries one description
-- of at most 20 characters per configured language, its industry
-- reference restricting. `business_partner` gains the nullable
-- industry reference, held by a composite foreign key restricting on
-- delete, so the database itself refuses the deletion the service
-- refuses. The five delivered industries stand inserted for every
-- standing tenant here; new tenants receive them at onboarding.
create table public.industry (
  client varchar(4) not null references public.client(client) on delete cascade,
  industry_code varchar(4) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, industry_code),
  constraint industry_code_format check (industry_code ~ '^[A-Z0-9]{1,4}$')
);
--> statement-breakpoint
create table public.industry_text (
  client varchar(4) not null references public.client(client) on delete cascade,
  industry_code varchar(4) not null,
  language_code varchar(5) not null,
  description varchar(20) not null,
  primary key (client, industry_code, language_code),
  constraint industry_text_industry_fk foreign key (client, industry_code)
    references public.industry (client, industry_code) on delete restrict,
  constraint industry_text_description_nonempty check (length(btrim(description)) >= 1)
);
--> statement-breakpoint
alter table public.business_partner add column industry varchar(4);
--> statement-breakpoint
alter table public.business_partner
  add constraint business_partner_industry_fk foreign key (client, industry)
  references public.industry (client, industry_code) on delete restrict;
--> statement-breakpoint
insert into public.industry (client, industry_code, created_by)
select c.client, v.code, 'SYSTEM'
from public.client c
cross join (values ('MEC1'), ('CHEM'), ('PHAR'), ('RETL'), ('CONS')) as v(code)
on conflict do nothing;
--> statement-breakpoint
insert into public.industry_text (client, industry_code, language_code, description)
select c.client, v.code, 'en', v.description
from public.client c
cross join (values
  ('MEC1', 'Mechanical Eng.'),
  ('CHEM', 'Chemical'),
  ('PHAR', 'Pharmaceutical'),
  ('RETL', 'Retail'),
  ('CONS', 'Construction')
) as v(code, description)
on conflict do nothing;
