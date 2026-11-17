-- 9302_factory_calendar_rules.sql
--
-- FOUND-01: factory calendar rules. Three tables (periods, holiday calendars, holiday days), one capability,
-- the registry entry for /config/factory-calendars and the SCAL alias.
-- Reference mapping (names only): period = TFACD, holiday calendar = THOCI, holiday day = THOC (+ THOCD / THOL folded in).
-- No data migration: existing factory_calendar rows gain no periods, so a calendar with no rules refuses to answer.
-- No role_capability row: granting CFG.FND.CALENDAR.DEFINE is a hand-run administrative act (as for 9296).

create table public.holiday_calendar (
  client              varchar(4)  not null references public.client(client) on delete cascade,
  holiday_calendar_id char(2)     not null,
  name                varchar(80) not null,
  valid_from_year     integer     not null,
  valid_to_year       integer     not null,
  created_by          varchar(60) not null default 'SYSTEM',
  created_at          timestamptz not null default now(),
  changed_by          varchar(60),
  changed_at          timestamptz,
  constraint holiday_calendar_pkey primary key (client, holiday_calendar_id),
  constraint holiday_calendar_key_format_ck check (holiday_calendar_id ~ '^[A-Z0-9]{2}$'),
  constraint holiday_calendar_years_ck check (valid_to_year >= valid_from_year
    and valid_from_year between 1900 and 9999 and valid_to_year between 1900 and 9999)
);

create table public.holiday_calendar_day (
  client              varchar(4)  not null,
  holiday_calendar_id char(2)     not null,
  date                date        not null,
  description         varchar(80) not null,
  created_by          varchar(60) not null default 'SYSTEM',
  created_at          timestamptz not null default now(),
  changed_by          varchar(60),
  changed_at          timestamptz,
  constraint holiday_calendar_day_pkey primary key (client, holiday_calendar_id, date),
  constraint holiday_calendar_day_calendar_fk foreign key (client, holiday_calendar_id)
    references public.holiday_calendar (client, holiday_calendar_id) on delete cascade
);

create table public.factory_calendar_period (
  client              varchar(4)  not null,
  calendar_id         char(2)     not null,
  valid_from          date        not null,
  valid_to            date        not null,
  monday              boolean     not null,
  tuesday             boolean     not null,
  wednesday           boolean     not null,
  thursday            boolean     not null,
  friday              boolean     not null,
  saturday            boolean     not null,
  sunday              boolean     not null,
  holiday_calendar_id char(2),
  created_by          varchar(60) not null default 'SYSTEM',
  created_at          timestamptz not null default now(),
  changed_by          varchar(60),
  changed_at          timestamptz,
  constraint factory_calendar_period_pkey primary key (client, calendar_id, valid_from),
  constraint factory_calendar_period_calendar_fk foreign key (client, calendar_id)
    references public.factory_calendar (client, calendar_id) on delete cascade,
  constraint factory_calendar_period_holiday_fk foreign key (client, holiday_calendar_id)
    references public.holiday_calendar (client, holiday_calendar_id) on delete restrict,
  constraint factory_calendar_period_range_ck check (valid_to >= valid_from)
);

do $$
declare t text;
begin
  foreach t in array array['holiday_calendar', 'holiday_calendar_day', 'factory_calendar_period'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client = current_setting('cairn.client', true))
      with check (client = current_setting('cairn.client', true))$p$, t);
  end loop;
end $$;

-- Master data under a DEFINE capability: a wrong period or holiday is removed for real, by a service that
-- records a change document. DELETE is therefore granted on purpose, on exactly these three tables.
grant select, insert, update, delete on table public.holiday_calendar to cairn_app;
grant select, insert, update, delete on table public.holiday_calendar_day to cairn_app;
grant select, insert, update, delete on table public.factory_calendar_period to cairn_app;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CFG.FND.CALENDAR.DEFINE', 'FND', 'CONFIGURE', false,
   'Maintain factory calendar periods (working weekdays) and holiday calendars with their dated holidays')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9302a000-0000-4000-8000-000000000001', 'CFG.FND.CALENDAR.DEFINE', null,
       'Factory calendars', 'CONFIG_ACTIVITY', 'FND',
       'Maintain the working weekdays of a factory calendar over dated periods, and the holiday calendars with their '
       || 'dated holidays. Movable holidays are entered by hand as explicit dates.',
       'TIER_1_BUILT', '/config/factory-calendars', 'B', null, true, 'MIGRATION_9302', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9302a000-0000-4000-8000-000000000001' or r.our_code = 'CFG.FND.CALENDAR.DEFINE');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9302b000-0000-4000-8000-000000000001', '9302a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'SCAL', 'SEARCH_ONLY', 'MIGRATION_9302', now()
 where exists (select 1 from public.term_registry r where r.id = '9302a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9302b000-0000-4000-8000-000000000001');
