-- 9296_document_layout_and_output_dispatch.sql
--
-- MAIL-03: the per-company-code document letterhead (SE78 / SE71), and the OUTPUT.DISPATCH job.
-- One new table, one capability, the registry entry for /config/document-layout, one job definition.
-- No role_capability row: granting CFG.FND.DOCUMENT.LAYOUT.DEFINE is a hand-run administrative act.

create table public.document_layout (
  client            varchar(4)   not null references public.client(client) on delete cascade,
  company_code      varchar(10)  not null,
  display_name      varchar(160),
  address_override  text,
  header_text       varchar(200),
  footer_text       text,
  logo_data         text,
  logo_mime         varchar(30),
  logo_file_name    varchar(120),
  show_page_numbers boolean      not null default true,
  created_by        varchar(60)  not null default 'SYSTEM',
  created_at        timestamptz  not null default now(),
  changed_by        varchar(60),
  changed_at        timestamptz,
  constraint document_layout_pkey primary key (client, company_code),
  constraint document_layout_company_code_fk foreign key (client, company_code)
    references public.company_code (client, company_code) on delete cascade,
  constraint document_layout_logo_mime_ck check (logo_mime is null or logo_mime in ('image/png', 'image/jpeg'))
);

alter table public.document_layout enable row level security;
alter table public.document_layout force row level security;

create policy tenant_isolation on public.document_layout
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));

-- Mutable, never deleted: removing a logo clears columns, and the row cascades away with its company code.
grant select, insert, update on table public.document_layout to cairn_app;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('CFG.FND.DOCUMENT.LAYOUT.DEFINE', 'FND', 'CONFIGURE', false,
   'Maintain the document letterhead of a company code: logo, display name, address, header and footer text')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9296a000-0000-4000-8000-000000000001', 'CFG.FND.DOCUMENT.LAYOUT.DEFINE', null,
       'Document layout', 'CONFIG_ACTIVITY', 'FND',
       'Maintain the letterhead printed and sent with output documents, one per company code: logo, display name, '
       || 'address override, header text, footer text and page numbers. The name and address default to the company code.',
       'TIER_1_BUILT', '/config/document-layout', 'B', null, true, 'MIGRATION_9296', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9296a000-0000-4000-8000-000000000001' or r.our_code = 'CFG.FND.DOCUMENT.LAYOUT.DEFINE');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9296b000-0000-4000-8000-000000000001', '9296a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'SE78', 'SEARCH_ONLY', 'MIGRATION_9296', now()
 where exists (select 1 from public.term_registry r where r.id = '9296a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9296b000-0000-4000-8000-000000000001');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9296b000-0000-4000-8000-000000000002', '9296a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'SE71', 'SEARCH_ONLY', 'MIGRATION_9296', now()
 where exists (select 1 from public.term_registry r where r.id = '9296a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9296b000-0000-4000-8000-000000000002');

insert into public.job_definition
  (code, name, module, queue, is_scheduled, schedule, max_retries, timeout_seconds, chunk_size, retention_days)
values
  ('OUTPUT.DISPATCH', 'Dispatch output', 'SD', 'OUTPUT', true, '*/2 * * * *', 1, 300, 25, 30)
on conflict (code) do nothing;
