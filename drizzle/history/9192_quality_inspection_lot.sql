-- 9192: the inspection lot, as a record and nothing more.
--
-- CAIRN.md §10.11 has always listed QM in Tier 3, "registry-only until requested", and the registry carried
-- no QM row: the platform had the machinery around an inspection and not the inspection itself. What was
-- verified on 2026-10-28 (docs/operational-readiness.md, "Quality management: verified coverage") is that
-- eight tables serve five classification terms and three batch-status terms, that no table named
-- inspection_lot, usage_decision, quality_notification or nonconformance exists anywhere, that no QM.*
-- capability is registered, and that /inventory/batch-cockpit answers the question "what is under
-- inspection" with a refusal: "An inspection lot is not stored. Nothing was read."
--
-- This migration adds the missing document. One lot per material-document line, pointing at the line rather
-- than repeating it: material, plant, storage location, batch, movement, quantity, unit and the stock
-- segment all stay where the posting put them, so a lot cannot disagree with the receipt it was opened on.
-- Duplicating them would be the defect, not the convenience.
--
-- What is deliberately NOT here, because nothing in this slice decides it:
--   * no results, characteristic values, tolerances or sampling. An owner has to write what passes
--     (D3, slice 4); until then a results column would be a schema guess with a test as its only reader.
--   * no usage-decision or status columns. The decision arrives with the act that decides it (slice 2),
--     and it is that act which needs the update right, the version guard and the one-way transition. A
--     lifecycle column reachable only by one value would be a placeholder.
--   * no stock, valuation or journal effect, and no batch status change (D3). The lot is opened against
--     goods that are already posted; whether they may move is governed by the segment and the restricted-use
--     indicator the receipt left behind, which the posting engines already enforce.
--   * no quality hold on the vendor payable (D4, DI-024) and no new availability rule (D5).
--   * no quarantine at receipt (D2, DI-022). That needs the receipt to honour movement_type
--     destination_stock_type in src/modules/inventory/goods-receipt.ts, a file with uncommitted owner work
--     in it right now. The configuration already exists and /config/movement-types already maintains it;
--     the posting path simply never reads it, and this migration does not pretend otherwise.
--
-- The table is append-only in this slice: opening writes a row, nothing rewrites it. So the runtime role is
-- left with the select and insert the database default already gives it, and the revocation below says out
-- loud that update and delete are not coming from the application. Slice 2 will add the grant in its own
-- migration, beside the code that needs it.

create table if not exists public.quality_lot (
  client varchar(4) not null references public.client (client) on delete cascade,
  lot_number varchar(20) not null,
  -- The receipt line the lot was opened against, addressed by its own key. No year is copied: the
  -- material document's key is (client, document number), and its year is read from the document.
  material_document_number varchar(20) not null,
  material_document_line integer not null,
  inspection_note varchar(200),
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint quality_lot_pk primary key (client, lot_number),
  constraint quality_lot_source_line_fk foreign key (client, material_document_number, material_document_line)
    references public.material_document_line (client, material_document_number, line_number) on delete restrict,
  constraint quality_lot_line_positive_ck check (material_document_line > 0),
  constraint quality_lot_note_length_ck check (inspection_note is null or length(trim(inspection_note)) > 0)
);

-- A repeated submission of the same request is one act, not two lots.
create unique index if not exists quality_lot_request_key_uq
  on public.quality_lot (client, request_key) where request_key is not null;
-- One lot per receipt line: a second request for the same goods is a decision on the first lot.
create unique index if not exists quality_lot_source_line_uq
  on public.quality_lot (client, material_document_number, material_document_line);

comment on table public.quality_lot is
  'An inspection lot: the standing request that one received quantity be examined. It names the material-document line the goods arrived on and owns no other fact - material, plant, storage location, batch, quantity, unit, movement and the stock segment are read from that line. Opening one posts nothing and blocks nothing. CAIRN.md 10.11 and decisions D1 to D5 of the 2026-10-28 readiness record.';
comment on column public.quality_lot.lot_number is
  'The lot number, drawn from the INSPLOT interval in the opening transaction and displayed as QL- plus seven digits, like every other document number in the platform.';
comment on column public.quality_lot.material_document_number is
  'The material document the goods arrived on. Its status and its year are read from the document, never copied onto the lot.';
comment on column public.quality_lot.material_document_line is
  'The line of that document. A reversal writes a new document naming the line it undoes, so whether these goods still stand is read from that pair instead of stored as a status that could go stale.';
comment on column public.quality_lot.inspection_note is
  'What the person opening the lot wrote about it. Free text, not a result: nothing reads it as a judgement about the goods.';
comment on column public.quality_lot.request_key is
  'The caller''s idempotency key. A submission that repeats a key returns the lot the first attempt created rather than opening a second one.';

revoke update, delete, truncate on table public.quality_lot from cairn_app;
revoke all on table public.quality_lot from public;

-- Tenant-scoped, so it carries the forced policy every other tenant table is judged by (D-041). A lot read
-- without the tenant set must see nothing, and a lot written for another client must be refused.
do $$
begin
  alter table public.quality_lot enable row level security;
  alter table public.quality_lot force row level security;
  create policy tenant_isolation on public.quality_lot
    using (client = current_setting('cairn.client', true))
    with check (client = current_setting('cairn.client', true));
end $$;

-- The capability the lot screen and its opening action both name. It is not posting-relevant, and the
-- description says so, because that is the whole point of slice 1: a lot records the request for an
-- inspection and takes no decision about the goods.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'QM.LOT.CREATE', 'QM', 'CREATE', false,
  'Open and read an inspection lot at /quality/lots. A lot names the material-document line the goods arrived '
  || 'on and asks that they be examined: it posts no stock, changes no valuation, writes no journal and does '
  || 'not touch the batch. The usage decision that would restrict or release the goods is not this act.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- Who may open a lot today: whoever posts a goods receipt, and whoever changes a batch. No QM role model
-- exists, so the code is offered to the two roles that already stand where inspection would be noticed, and
-- nothing else is widened. An administrator role that holds the module pattern needs no row here.
insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'QM.LOT.CREATE', 'MIGRATION_9192'
  from role_capability rc
 where rc.capability_code in ('INV.GR.POST', 'INV.BATCH.CHANGE')
on conflict (client, role_code, capability_code) do nothing;

-- The registry stops promising QM an entry it does not have. First QM row in term_registry, and it states
-- the boundary in the description so the registry cannot be read as a claim that inspection works end to end.
insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'QM.LOT.CREATE',
  'quality_lot',
  'Inspection lot',
  'TRANSACTION',
  'QM',
  'The record that a received quantity is under inspection: one lot per material-document line, read back '
  || 'with the movement, batch and segment of the goods it names. The lot posts nothing and decides nothing - '
  || 'results, tolerances, sampling and the usage decision that would restrict or release the goods are not '
  || 'built (D1 to D5, 2026-10-28), and quarantine at receipt is still open as DI-022.',
  'TIER_2_CONFIGURED',
  '/quality/lots',
  'C',
  'MIGRATION_9192'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  coverage_tier = excluded.coverage_tier,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9192',
  changed_at = now();
