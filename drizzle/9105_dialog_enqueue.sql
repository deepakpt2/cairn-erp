-- Dialog enqueue. The advisory lock dies with the request, so it cannot
-- keep a second user out of a document that is already open. This row is
-- the SM12 entry: exclusive while one session has the object in change,
-- display-only for every other session. It is not a posting and it does
-- not version the document.

create table public.enqueue_entry (
  client varchar(4) not null references public.client (client) on delete cascade,
  lock_object varchar(40) not null,
  argument varchar(200) not null,
  mode varchar(16) not null default 'EXCLUSIVE',
  owner_user varchar(60) not null,
  owner_session_id varchar(36) not null references public.user_session (id) on delete cascade,
  transaction_code varchar(64),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  primary key (client, lock_object, argument),
  constraint enqueue_entry_mode_ck check (mode in ('EXCLUSIVE', 'SHARED')),
  constraint enqueue_entry_argument_ck check (length(btrim(argument)) > 0)
);

create index enqueue_entry_session_idx on public.enqueue_entry (client, owner_session_id);
create index enqueue_entry_user_idx on public.enqueue_entry (client, owner_user);

alter table public.enqueue_entry enable row level security;
alter table public.enqueue_entry force row level security;
create policy tenant_isolation on public.enqueue_entry
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.enqueue_entry from public;
grant select, insert, update, delete on public.enqueue_entry to cairn_app;

insert into capability (code, module, action, is_posting_relevant, description)
values
  (
    'PLT.LOCK.DISPLAY',
    'PLT',
    'DISPLAY',
    false,
    'Display the dialog enqueue, the locks held while a document or configuration row is open in change'
  ),
  (
    'PLT.LOCK.DELETE',
    'PLT',
    'CONFIGURE',
    false,
    'Delete a dialog enqueue entry. The document is not changed. The holder is named in the change document.'
  )
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'PLT.LOCK.DISPLAY',
  null,
  'Lock monitor',
  'TRANSACTION',
  'PLT',
  $sm12$The dialog enqueue. One session holds a document or a configuration row in change. Every other session may open it and cannot change it. A lock leaves when that session releases it, signs out, or stops answering. Deleting a lock does not change the document.$sm12$,
  'TIER_1_BUILT',
  '/platform/locks',
  'B',
  'MIGRATION_9105'
)
on conflict (our_code) do update set
  title = excluded.title,
  description = excluded.description,
  route_path = excluded.route_path,
  coverage_tier = excluded.coverage_tier,
  changed_by = 'MIGRATION_9105',
  changed_at = now();

insert into term_alias (id, term_id, external_system, alias, usage, created_by)
select gen_random_uuid()::text, t.id, 'REFERENCE_ERP', 'SM12', 'SEARCH_ONLY', 'MIGRATION_9105'
from term_registry t
where t.our_code = 'PLT.LOCK.DISPLAY'
on conflict (external_system, alias) do nothing;
