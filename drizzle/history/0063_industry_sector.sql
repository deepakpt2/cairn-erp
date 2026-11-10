-- SCR-052 / R-100 (stage 2): the industry sector master, and the
-- material description narrowing to its reference width.
--
-- Industry sector becomes a maintained tenant master: a one-character
-- key and a name (OMS3 shape). The standard sectors are delivered for
-- every standing tenant; new tenants receive them from the material
-- defaults. Standing materials carrying the free-text MANUFACTURING —
-- or anything that is not a delivered sector key — convert to M
-- (mechanical engineering, the manufacturing default; R-100 records
-- the conversion). The material description narrows from 200 to the
-- reference 40 characters; verified before this migration ran that no
-- standing description exceeds 40, so nothing is shortened.
create table public.industry_sector (
  client varchar(4) not null references public.client(client) on delete cascade,
  sector varchar(1) not null,
  name varchar(40) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, sector),
  constraint industry_sector_format_ck check (sector ~ '^[A-Z0-9]$')
);
--> statement-breakpoint
insert into public.industry_sector (client, sector, name, created_by)
select c.client, s.sector, s.name, 'SYSTEM'
from public.client c
cross join (values
  ('A', 'Plant engineering and construction'),
  ('C', 'Chemical industry'),
  ('M', 'Mechanical engineering'),
  ('P', 'Pharmaceuticals'),
  ('R', 'Retail')
) as s(sector, name)
on conflict do nothing;
--> statement-breakpoint
update public.material
set industry_sector = 'M'
where industry_sector is not null
  and (length(industry_sector) <> 1 or upper(industry_sector) not in ('A', 'C', 'M', 'P', 'R'));
--> statement-breakpoint
update public.material
set industry_sector = upper(industry_sector)
where industry_sector is not null and length(industry_sector) = 1;
--> statement-breakpoint
alter table public.material alter column industry_sector type varchar(1);
--> statement-breakpoint
alter table public.material alter column description type varchar(40);
