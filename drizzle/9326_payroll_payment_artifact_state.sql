-- 9326_payroll_payment_artifact_state.sql
--
-- Distinguishes a genuinely LEGACY owner (pre-host-storage; may legitimately have no artifact and be served
-- from its stored body / immutable snapshot) from a NEW-format owner that MUST have a retained artifact.
--
-- The marker is written in the same transaction as the owner and its metadata. A new-format owner whose artifact
-- metadata or file is missing FAILS CLOSED instead of being treated as legacy. Rows created before this migration
-- have no marker and remain legacy until an operator backfills them (see docs).

create table if not exists public.payroll_payment_artifact_state (
  client      varchar(4)  not null references public.client(client) on delete cascade,
  owner_kind  varchar(10) not null,
  owner_id    varchar(36) not null,
  format      varchar(16) not null,
  changed_by  varchar(60) not null default 'SYSTEM',
  changed_at  timestamp with time zone not null default now(),
  constraint payroll_payment_artifact_state_pk primary key (client, owner_kind, owner_id),
  constraint payroll_payment_artifact_state_kind_ck check (owner_kind in ('FILE', 'REISSUE')),
  constraint payroll_payment_artifact_state_format_ck check (format = 'cad1')
);

alter table public.payroll_payment_artifact_state enable row level security;
alter table public.payroll_payment_artifact_state force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_artifact_state;
create policy tenant_isolation on public.payroll_payment_artifact_state
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

-- Insert-only evidence: the runtime role marks an owner once and never rewrites or deletes the marker.
grant select, insert on table public.payroll_payment_artifact_state to cairn_app;

comment on table public.payroll_payment_artifact_state is
  'Marks an owner as new-format (must have a retained cad1 artifact). Absence of a row means genuinely legacy.';
