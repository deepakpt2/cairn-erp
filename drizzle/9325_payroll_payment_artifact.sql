-- 9325_payroll_payment_artifact.sql
--
-- Private host storage for the generated salary payment CSVs themselves (original files and approved
-- replacements). The bytes live in an encrypted file under CAIRN_PAYMENT_FILE_DIR (never in the database,
-- web root or source checkout); this table holds only safe metadata and the opaque server-generated artifact id.
-- No plaintext CSV, account value or absolute path is stored here.
--
-- The artifact is published to disk and then this row commits; a committed row with a missing file fails closed
-- at download. Old encryptions and legacy database bodies/snapshots are preserved unchanged (this migration
-- writes no sensitive plaintext and mutates no evidence).

create table if not exists public.payroll_payment_artifact (
  client             varchar(4)    not null references public.client(client) on delete cascade,
  artifact_id        uuid          not null,
  -- Which record owns the artifact: an original prepared file or an approved replacement.
  owner_kind         varchar(10)   not null,
  owner_id           varchar(36)   not null,
  -- A stable business reference for display/audit (the file/preparation or reissue reference).
  file_reference     varchar(60)   not null,
  -- Where the encrypted envelope lives, relative to CAIRN_PAYMENT_FILE_DIR. Never absolute, never a URL.
  storage_path       varchar(120)  not null,
  storage_format     varchar(16)   not null default 'cad1',
  key_id             varchar(32)   not null,
  -- SHA-256 of the PLAINTEXT CSV, so integrity is checked after decryption and against the frozen snapshot.
  plaintext_sha256   varchar(64)   not null,
  byte_length        integer       not null,
  generation         integer       not null default 1,
  created_by         varchar(60)   not null default 'SYSTEM',
  created_at         timestamp with time zone not null default now(),
  changed_by         varchar(60),
  changed_at         timestamp with time zone,
  constraint payroll_payment_artifact_pk primary key (client, artifact_id),
  constraint payroll_payment_artifact_owner_uq unique (client, owner_kind, owner_id),
  constraint payroll_payment_artifact_uuidv4 check (
    substring(artifact_id::text from 15 for 1) = '4'
    and substring(artifact_id::text from 20 for 1) in ('8', '9', 'a', 'b')
  ),
  constraint payroll_payment_artifact_kind_ck check (owner_kind in ('FILE', 'REISSUE')),
  constraint payroll_payment_artifact_format_ck check (storage_format = 'cad1'),
  constraint payroll_payment_artifact_len_ck check (byte_length > 0),
  constraint payroll_payment_artifact_gen_ck check (generation > 0)
);
create index if not exists payroll_payment_artifact_owner_idx
  on public.payroll_payment_artifact (client, owner_kind, owner_id);

alter table public.payroll_payment_artifact enable row level security;
alter table public.payroll_payment_artifact force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_artifact;
create policy tenant_isolation on public.payroll_payment_artifact
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

-- The runtime role reads and inserts an artifact once; it never updates or deletes evidence.
grant select, insert on table public.payroll_payment_artifact to cairn_app;

comment on table public.payroll_payment_artifact is
  'Encrypted salary payment CSV in private host storage. Row holds only metadata and an opaque artifact id; the file lives under CAIRN_PAYMENT_FILE_DIR.';
