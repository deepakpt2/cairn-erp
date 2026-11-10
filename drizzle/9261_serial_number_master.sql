-- ── Serial numbers ───────────────────────────────────────────────────────────
--
-- §5.5b. A batch is a kind of goods; a serial is one thing. Where batch
-- determination answers "which boxes come off the shelf", a serial number answers
-- "which one of these", and it stays with that unit for the rest of its life —
-- which customer has it, and which one came back.
--
-- Nothing of this has existed in the canon until now, and the codebase says so in
-- three places that refuse the work by name. `transfer-posting.ts` pushes
-- 'serial numbers (canon carries no serial-number master)' into its list of
-- unmet requirements; `physical-inventory-posting.ts` refuses a movement that
-- requires a serial; and `material-document-list.ts` answers 'A serial number is
-- not on the material document.' What stands here is the master those three were
-- telling the truth about the absence of.
--
-- Three departures from SAP, and why:
--
-- 1. **Four statuses, not the dozens of I0068.** SAP carries AVLB, ESTO, UBEL,
--    RETN, SCRP, EQUI and others, most of them belonging to equipment
--    management and to a plant maintenance canon this one does not carry. The
--    four here are the ones a delivery actually moves a unit between: it has not
--    arrived yet, it stands in a store, it has gone to a customer, or it is not
--    coming back.
--
-- 2. **No serial number profile (OMS1 / MARC-SERNP).** SAP hangs a profile on a
--    material per plant and the profile drives whether serials are required,
--    whether they are optional, and what happens on a goods issue. This canon
--    already carries the switch it needs — `material.requires_serial` — and a
--    profile is a second answer to a question the material master was already
--    asked. A material that demands serials demands them; one that does not is
--    untouched.
--
-- 3. **The master is a record, not the stock ledger.** A serialised material
--    counted as three and three serial rows standing in the store can still
--    disagree, and nothing here reconciles them. Making the serial the unit of
--    stock would mean every goods movement in the system — receipts, transfers,
--    inventory differences, goods issues — writing a serial row it has no place
--    to be given one. That is a different and much larger piece of work. So this
--    master records what was captured where a serial is captured, and says so
--    plainly rather than pretending to be the books.
--
-- Nothing is seeded. A tenant that maintains no serial rows picks a serialised
-- material and is told it has none standing, which is the truth.

create table serial_number (
  client varchar(4) not null references client (client),
  material_number varchar(40) not null,
  serial_number varchar(40) not null,
  -- Where the unit stands. Blank plant is a serial that has been created but not
  -- put away; blank storage location is a serial whose store does not bin it.
  plant varchar(10),
  storage_location varchar(10) not null default '',
  stock_type varchar(16) not null default 'UNRESTRICTED',
  batch_number varchar(40) not null default '',
  -- AVAILABLE | IN_STOCK | DELIVERED | SCRAPPED
  status varchar(16) not null default 'AVAILABLE',
  -- Where the unit went, written when it is delivered and cleared when it comes
  -- back. A serial is the only thing in this canon that can name the customer
  -- holding a particular piece of an order.
  delivery_number varchar(20) not null default '',
  order_number varchar(20) not null default '',
  customer_number varchar(40) not null default '',
  request_key varchar(64),
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, material_number, serial_number),
  constraint serial_number_status_ck
    check (status in ('AVAILABLE', 'IN_STOCK', 'DELIVERED', 'SCRAPPED')),
  constraint serial_number_delivered_ck
    check (status <> 'DELIVERED' or delivery_number <> ''),
  constraint serial_number_plant_ck
    check (status in ('AVAILABLE') or plant is not null)
);

comment on table serial_number is
  'One serialised unit of one material, and where that unit stands (§5.5b). A batch is a kind of goods; a serial is one thing, and it keeps its identity for the rest of its life — which customer holds it, and which one came back. Four statuses: created but not put away, standing in a store, gone to a customer, and not coming back. This master is a record of what was captured where a serial is captured; it is not the stock ledger, and it does not reconcile itself against it.';

comment on column serial_number.status is
  'AVAILABLE is a unit that has been created and not put away. IN_STOCK is a unit standing in a store. DELIVERED is a unit that has gone out to a customer, and the delivery, order and customer it went on are written beside it. SCRAPPED is a unit that is not coming back. A unit that has gone out and come back is IN_STOCK again with nothing written against it, because goods that came back are goods that never went.';

comment on column serial_number.delivery_number is
  'The delivery the unit went out on, blank when the unit is not out. The check that a delivered unit names a delivery is the whole reason for this column: a serial that says it has gone but cannot say where has not recorded a delivery, it has lost one.';

create index serial_number_capture_ix
  on serial_number (client, material_number, plant, status);

create index serial_number_whereabouts_ix
  on serial_number (client, customer_number, delivery_number);

-- What a pick captured. One row per unit that went out on one pick row, so the
-- pick history can say which units went and not merely how many.
create table delivery_picking_serial (
  client varchar(4) not null references client (client),
  delivery_number varchar(20) not null,
  line_number integer not null,
  pick_number integer not null,
  serial_number varchar(40) not null,
  material_number varchar(40) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, delivery_number, line_number, pick_number, serial_number)
);

comment on table delivery_picking_serial is
  'Which unit went out on which pick row (§5.5b). Append-only, like the picking history it belongs to: a correction is a row of the opposite sign, not an edit of this one. The serial itself carries the delivery it went on, so this table is the pick''s side of the record — the answer to "what did we actually hand over" that a picking quantity cannot give.';

alter table serial_number enable row level security;
alter table delivery_picking_serial enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['serial_number', 'delivery_picking_serial']
  loop
    execute format('drop policy if exists %I on %I', table_name || '_tenant', table_name);
    execute format(
      'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      table_name || '_tenant', table_name
    );
    execute format('revoke all on table %I from public', table_name);
    execute format('grant select, insert, update, delete on table %I to cairn_app', table_name);
  end loop;
end $$;

-- ── The capability ────────────────────────────────────────────────────────
-- Maintaining the master is its own act: the picker who captures a serial is not
-- the person who decides which units exist.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'INV.SERIAL.MAINTAIN', 'INV', 'SERIAL', false,
  'Maintain serial numbers, at /inventory/serial-numbers (§5.5b): one row per serialised unit of a material, with where it stands, where it went and which customer holds it. A unit is captured when a delivery pick takes it, so a material that demands serials asks the picker which units came off the shelf and refuses a pick that names fewer. Nothing is seeded: a tenant that maintains no serial rows is told a serialised material has none standing, which is the truth.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
