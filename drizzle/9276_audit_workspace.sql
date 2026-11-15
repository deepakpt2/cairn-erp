-- 9276_audit_workspace.sql
--
-- Auditor workspace (AUDIT.WORKSPACE): a time-boxed, scoped, read-only grant for a
-- person acting as auditor, the working state an engagement keeps, and the grant id
-- on the access log that already exists.
--
-- SAP reference: GRC Emergency Access Management ("Firefighter") for the grant,
-- SAP Audit Management for findings and requests to management, AIS for the
-- read-only reporting tree.
--
-- What a grant is NOT: a capability. A grant names scope (companies, periods,
-- modules) and a window. While it is live, `effectiveGrants()` cuts the holder's
-- authority down to read-kind capabilities (see src/modules/audit/read-only.ts), and
-- nothing anywhere writes a role_capability or user_capability row for it.

-- ── The grant id on the access log ──────────────────────────────────────────
-- The log stays append-only: cairn_app holds INSERT and SELECT on it and nothing else.

alter table public.audit_access_log
  add column if not exists grant_id varchar(36);

create index if not exists audit_access_log_grant_idx
  on public.audit_access_log (client, grant_id)
  where grant_id is not null;

comment on column public.audit_access_log.grant_id is
  'The audit grant this read or export was made under, when it was made under one. Null otherwise.';

-- ── The grant ───────────────────────────────────────────────────────────────

create table if not exists public.audit_grant (
  client             varchar(4)  not null references public.client(client) on delete cascade,
  grant_id           varchar(36) not null,
  auditor_user_id    varchar(36) not null,
  granted_by_user_id varchar(36) not null,
  valid_from         date not null,
  -- Not null, deliberately stricter than delegation.valid_to: an auditor grant is
  -- always time-boxed, and one that never ends is the failure this column prevents.
  valid_to           date not null,
  status             varchar(20) not null default 'DRAFT',
  reason             text not null,
  revoked_by_user_id varchar(36),
  revoked_at         timestamp with time zone,
  created_by         varchar(60) not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  primary key (client, grant_id),
  constraint audit_grant_period_ck check (valid_to > valid_from),
  constraint audit_grant_status_ck
    check (status in ('DRAFT','ACTIVE','EXPIRED','REVOKED'))
);
create index if not exists audit_grant_auditor_idx
  on public.audit_grant (client, auditor_user_id);
create index if not exists audit_grant_status_idx
  on public.audit_grant (client, status);

comment on table public.audit_grant is
  'Time-boxed, scoped, read-only access for a person acting as auditor. Carries scope, never a capability.';

-- ── Where it applies ────────────────────────────────────────────────────────

create table if not exists public.audit_grant_scope (
  client      varchar(4)  not null references public.client(client) on delete cascade,
  grant_id    varchar(36) not null,
  scope_kind  varchar(20) not null,
  scope_value varchar(20) not null,
  primary key (client, grant_id, scope_kind, scope_value),
  constraint audit_grant_scope_kind_ck
    check (scope_kind in ('COMPANY_CODE','PERIOD','MODULE')),
  constraint audit_grant_scope_grant_fk foreign key (client, grant_id)
    references public.audit_grant (client, grant_id) on delete cascade
);
create index if not exists audit_grant_scope_grant_idx
  on public.audit_grant_scope (client, grant_id);

-- ── Working state: findings, notes, bookmarks, requests to management ────────

create table if not exists public.audit_finding (
  client               varchar(4)  not null references public.client(client) on delete cascade,
  finding_id           varchar(36) not null,
  grant_id             varchar(36),
  kind                 varchar(20) not null,
  subject              varchar(120) not null,
  body                 text not null,
  object_class         varchar(64),
  object_key           varchar(120),
  status               varchar(20) not null default 'OPEN',
  response             text,
  raised_by_user_id    varchar(36) not null,
  responded_by_user_id varchar(36),
  raised_at            timestamp with time zone not null default now(),
  responded_at         timestamp with time zone,
  created_by           varchar(60) not null default 'SYSTEM',
  created_at           timestamp with time zone not null default now(),
  changed_by           varchar(60),
  changed_at           timestamp with time zone,
  primary key (client, finding_id),
  constraint audit_finding_kind_ck
    check (kind in ('FINDING','NOTE','BOOKMARK','REQUEST')),
  constraint audit_finding_status_ck
    check (status in ('OPEN','ANSWERED','ACCEPTED','WITHDRAWN'))
);
create index if not exists audit_finding_grant_idx
  on public.audit_finding (client, grant_id);
create index if not exists audit_finding_status_idx
  on public.audit_finding (client, status);

-- ── Row level security and the runtime grants ───────────────────────────────
-- Nothing here is ever deleted by the application: a grant is revoked, a finding
-- is withdrawn, and a scope row lives and dies with its grant.

alter table public.audit_grant enable row level security;
alter table public.audit_grant force row level security;
drop policy if exists tenant_isolation on public.audit_grant;
create policy tenant_isolation on public.audit_grant
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.audit_grant from public;
grant select, insert, update on table public.audit_grant to cairn_app;

alter table public.audit_grant_scope enable row level security;
alter table public.audit_grant_scope force row level security;
drop policy if exists tenant_isolation on public.audit_grant_scope;
create policy tenant_isolation on public.audit_grant_scope
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.audit_grant_scope from public;
grant select, insert on table public.audit_grant_scope to cairn_app;

alter table public.audit_finding enable row level security;
alter table public.audit_finding force row level security;
drop policy if exists tenant_isolation on public.audit_finding;
create policy tenant_isolation on public.audit_finding
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.audit_finding from public;
grant select, insert, update on table public.audit_finding to cairn_app;

-- ── Capabilities ────────────────────────────────────────────────────────────
-- AUDIT.WORKSPACE, AUDIT.TRAIL.VIEW and AUDIT.EVIDENCE.EXPORT already stand
-- (baseline). The two below are new: granting access and answering a request are
-- management's acts, so the auditor must never hold either. Neither is read-kind,
-- so a live audit grant strips both even from a holder who has them.

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('AUDIT.ACCESS.GRANT', 'AUDIT', 'MAINTAIN', false,
   'Grant and revoke time-boxed, scoped, read-only auditor access'),
  ('AUDIT.REQUEST.RESPOND', 'AUDIT', 'CHANGE', false,
   'Answer an auditor''s finding or request to management')
on conflict (code) do nothing;

-- ── Registry: route, tier and the names an auditor searches for ─────────────
-- term_registry has no unique key on our_code, so every insert is guarded by the
-- fixed id and by the code; re-running this file adds nothing.

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select v.id, v.our_code, null, v.title, 'TRANSACTION', 'AUDIT', v.description, 'TIER_1_BUILT', v.route_path,
       'B', null, true, 'MIGRATION_9276', now(), null, null
  from (values
    ('9276a000-0000-4000-8000-000000000001', 'AUDIT.WORKSPACE', 'Auditor workspace',
     'Time-boxed, scoped, read-only access for a person acting as auditor, with the working state an '
     || 'engagement needs. No posting capability can be held through this grant. SAP: GRC Emergency '
     || 'Access Management and SAP Audit Management; the read-only chain AIS opens.',
     '/audit/workspace'),
    ('9276a000-0000-4000-8000-000000000002', 'AUDIT.TRAIL.VIEW', 'Change document trail',
     'Field-level before/after with user, timestamp, reason and the transaction used, for master data and '
     || 'configuration. SAP SM20 and SCU3.',
     '/audit/workspace'),
    ('9276a000-0000-4000-8000-000000000003', 'AUDIT.EVIDENCE.EXPORT', 'Export an evidence pack',
     'Export what an engagement gathered. Every export is logged against the auditor who made it.',
     '/audit/findings'),
    ('9276a000-0000-4000-8000-000000000004', 'AUDIT.ACCESS.GRANT', 'Auditor access grants',
     'Grant and revoke time-boxed, scoped, read-only access for a person acting as auditor. Held by a '
     || 'controller, never by the auditor. SAP: GRC Emergency Access Management.',
     '/audit/grants'),
    ('9276a000-0000-4000-8000-000000000005', 'AUDIT.REQUEST.RESPOND', 'Answer audit findings and requests',
     'Management''s answer to an auditor''s finding or request, with status. The raiser cannot answer '
     || 'their own. SAP: SAP Audit Management.',
     '/audit/findings')
  ) as v(id, our_code, title, description, route_path)
 where not exists (select 1 from public.term_registry r where r.id = v.id or r.our_code = v.our_code);

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, v.term_id, 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9276', now()
  from (values
    ('9276b000-0000-4000-8000-000000000001', '9276a000-0000-4000-8000-000000000001', 'AIS'),
    ('9276b000-0000-4000-8000-000000000002', '9276a000-0000-4000-8000-000000000001', 'GRC_FIREFIGHTER'),
    ('9276b000-0000-4000-8000-000000000003', '9276a000-0000-4000-8000-000000000002', 'SM20'),
    ('9276b000-0000-4000-8000-000000000004', '9276a000-0000-4000-8000-000000000002', 'SCU3'),
    ('9276b000-0000-4000-8000-000000000005', '9276a000-0000-4000-8000-000000000003', 'AUDIT_EXPORT')
  ) as v(id, term_id, alias)
 where exists (select 1 from public.term_registry r where r.id = v.term_id)
   and not exists (select 1 from public.term_alias a where a.id = v.id);
