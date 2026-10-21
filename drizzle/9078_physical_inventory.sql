-- SCR-142 (B-906/§26.918): physical inventory documents (MI01) — the count in progress.
--
-- Three rounds refused a package table because the ledger already held the fact. A count
-- is the opposite case: nothing in material_document records "these materials are being
-- counted in this plant". So the count earns its own two tables and duplicates nothing.
--
-- The header carries no company code. Its company stands on the plant, which is where the
-- posting read will take it, so a company column here would be a second copy of a fact that
-- could drift — the standing ruling from MB03 (§26.877) through CO01 (§26.898).
--
-- fiscal_year is kept, and it is not an exception to that rule: it is the document's own
-- identity and the scope of its number interval, exactly as material_document.document_year
-- is. It is derived from the planned count date against the plant's company fiscal year
-- variant, never typed.
--
-- Batch (CHARG), special stock categories and the cycle-count indicator are absent by name:
-- canon defers batch in every movement, carries stock types rather than SAP special stock,
-- and has no count scheduling.
--
-- Only CREATED and CANCELLED are reachable this round. COUNTED arrives with count entry
-- (MI04) and ADJUSTED with difference posting (MI07); the check widens in those rounds
-- rather than naming states nothing can reach.

create table if not exists public.physical_inventory_document (
  client varchar(4) not null references public.client (client) on delete cascade,
  inventory_document_number varchar(12) not null,
  fiscal_year integer not null,
  plant varchar(10) not null,
  storage_location varchar(10),
  planned_count_date varchar(10) not null,
  posting_block boolean not null default false,
  status varchar(16) not null default 'CREATED',
  request_key varchar(64),
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint physical_inventory_document_pk
    primary key (client, inventory_document_number, fiscal_year),
  constraint physical_inventory_document_plant_fk foreign key (client, plant)
    references public.plant (client, plant) on delete restrict,
  constraint physical_inventory_document_status_ck
    check (status in ('CREATED', 'CANCELLED')),
  constraint physical_inventory_document_date_ck
    check (planned_count_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
);

create table if not exists public.physical_inventory_item (
  client varchar(4) not null,
  inventory_document_number varchar(12) not null,
  fiscal_year integer not null,
  item_number integer not null,
  material_number varchar(40) not null,
  created_by varchar(64) not null,
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint physical_inventory_item_pk
    primary key (client, inventory_document_number, fiscal_year, item_number),
  constraint physical_inventory_item_document_fk
    foreign key (client, inventory_document_number, fiscal_year)
    references public.physical_inventory_document (client, inventory_document_number, fiscal_year)
    on delete cascade,
  constraint physical_inventory_item_quantity_ck check (item_number > 0)
);

-- One material, once, per document: the grid may not name the same material twice, and the
-- database says so rather than the service remembering to.
create unique index if not exists physical_inventory_item_material_key
  on public.physical_inventory_item (client, inventory_document_number, fiscal_year, material_number);

-- One request key per tenant: a resubmitted create finds the count it already made.
create unique index if not exists physical_inventory_document_request_key_idx
  on public.physical_inventory_document (client, request_key)
  where request_key is not null;
