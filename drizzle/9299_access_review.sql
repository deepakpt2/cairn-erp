-- 9299_access_review.sql
--
-- ITEM-19: access review (user access recertification) at /audit/access-review.
-- Two tables, one capability, the registry entry. No t-code alias (a GRC product, not a transaction),
-- no role_capability row (granting AUDIT.ACCESS.REVIEW is a hand-run administrative act), no job.
-- No DELETE on either table: a review is evidence, and a cancelled review keeps its status.

create table public.access_review (
  client               varchar(4)   not null references public.client(client) on delete cascade,
  review_id            varchar(36)  not null,
  code                 varchar(40)  not null,
  name                 varchar(100) not null,
  review_date          date         not null,
  role_filter          varchar(40),
  capability_filter    varchar(64),
  user_filter          varchar(36),
  status               varchar(16)  not null default 'OPEN',
  reason               text         not null,
  completed_by_user_id varchar(36),
  completed_at         timestamptz,
  request_key          varchar(64),
  created_by           varchar(60)  not null default 'SYSTEM',
  created_at           timestamptz  not null default now(),
  changed_by           varchar(60),
  changed_at           timestamptz,
  constraint access_review_pkey primary key (client, review_id),
  constraint access_review_status_ck check (status in ('OPEN', 'COMPLETED', 'CANCELLED'))
);
create unique index access_review_request_key_uq on public.access_review (client, request_key) where request_key is not null;
create index access_review_status_idx on public.access_review (client, status);

create table public.access_review_item (
  client                 varchar(4)   not null references public.client(client) on delete cascade,
  review_id              varchar(36)  not null,
  line_number            integer      not null,
  subject_user_id        varchar(36)  not null,
  role_code              varchar(40)  not null,
  role_name              varchar(100),
  valid_from             timestamptz,
  valid_to               timestamptz,
  effective_capabilities text,
  sod_conflicts          text,
  decision               varchar(16)  not null default 'PENDING',
  decided_by_user_id     varchar(36),
  decided_at             timestamptz,
  decision_reason        text,
  applied_at             timestamptz,
  applied_by_user_id     varchar(36),
  apply_error            text,
  created_by             varchar(60)  not null default 'SYSTEM',
  created_at             timestamptz  not null default now(),
  changed_by             varchar(60),
  changed_at             timestamptz,
  constraint access_review_item_pkey primary key (client, review_id, line_number),
  constraint access_review_item_line_ck check (line_number > 0),
  constraint access_review_item_decision_ck check (decision in ('PENDING', 'CERTIFIED', 'REVOKE')),
  constraint access_review_item_decided_ck check (
    (decision = 'PENDING' and decision_reason is null) or (decision <> 'PENDING' and decision_reason is not null)),
  constraint access_review_item_review_fk foreign key (client, review_id)
    references public.access_review (client, review_id) on delete cascade
);
create index access_review_item_subject_idx on public.access_review_item (client, review_id, subject_user_id);

do $$
declare t text;
begin
  foreach t in array array['access_review', 'access_review_item'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;

grant select, insert, update on table public.access_review to cairn_app;
grant select, insert, update on table public.access_review_item to cairn_app;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('AUDIT.ACCESS.REVIEW', 'AUDIT', 'CONFIGURE', false,
   'Raise and decide a periodic review of the roles users hold. Records decisions; removes nothing.')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9299a000-0000-4000-8000-000000000001', 'AUDIT.ACCESS.REVIEW', 'access_review',
       'Access review', 'TRANSACTION', 'AUDIT',
       'Recertify the roles users hold: freeze one item per current role assignment, decide each as certified or '
       || 'to be revoked with a reason, have an administrator apply the revocations, then complete the review as '
       || 'evidence. Records decisions; grants and removes nothing itself.',
       'TIER_1_BUILT', '/audit/access-review', 'B', null, true, 'MIGRATION_9299', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9299a000-0000-4000-8000-000000000001' or r.our_code = 'AUDIT.ACCESS.REVIEW');
