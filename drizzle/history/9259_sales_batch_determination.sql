-- §5.5a (audit gap E1): batch determination for sales — which batch an item is picked from.
--
-- SAP's batch determination in SD answers one question at the dock: **this delivery item is asking
-- for forty of a material, and there are five batches of it in the store — which ones does the
-- picker take?** The answer is a sort rule and a selection, maintained per business partner of the
-- condition technique, and its output is a set of proposals that can split the item across batches
-- when no single one of them covers it.
--
-- This package already carries a batch *search* strategy stack — condition tables (OMA1), access
-- sequences (OMCY), strategy types (OMCW), allocations (OMCG) and strategies (MBC1) — and that
-- stack is deliberately left alone. It answers a different question: an operator in production asks
-- "which batches match this characteristic", gets a list, and chooses. A picker in the warehouse
-- does not choose; the delivery has already committed to a quantity and the goods have to come from
-- somewhere. Determination is the act of answering that from stock, and it is driven by availability
-- rather than by a characteristic.
--
-- **Nothing is seeded.** No rule is delivered, so a delivery picked the day this is applied is
-- picked exactly as it was the day before: with no batch named, as the picker has always done it.
-- That is the same promise the incompletion procedure makes (9255) and it is the one that lets a
-- change like this be applied without rejudging anything.

-- ── The rule ───────────────────────────────────────────────────────────────
-- One row per selection: what it answers for, and in what order it takes the batches it finds.
-- The empty position is the general rule, which is why those columns default to '' rather than to
-- null — null in a unique key would let two "any customer" rows stand side by side.
create table sales_batch_determination_rule (
  client varchar(4) not null references client (client) on delete cascade,
  rule_number varchar(10) not null,
  -- What the rule answers for. Blank is every value of it.
  sales_org varchar(4) not null default '',
  distribution_channel varchar(2) not null default '',
  customer_number varchar(40) not null default '',
  material_number varchar(40) not null default '',
  plant varchar(10) not null default '',
  -- The order the batches are taken in. FIFO is the batch that has stood longest; LIFO the newest;
  -- EXPIRY is the soonest to expire, which is what a perishable store actually wants and is the rule
  -- SAP calls FEFO; BATCH_NUMBER is the plainest order there is and the one an auditor can check.
  sort_rule varchar(12) not null default 'FIFO',
  is_active boolean not null default true,
  -- A rule is valid for a period, as a condition record is, so a tenant can change the order it
  -- takes stock in without rewriting what it did last year.
  validity_from date not null,
  validity_to date not null,
  name varchar(40) not null default '',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, rule_number),
  constraint sales_batch_determination_sort_ck
    check (sort_rule in ('FIFO', 'LIFO', 'EXPIRY', 'BATCH_NUMBER')),
  constraint sales_batch_determination_validity_ck check (validity_to >= validity_from)
);

comment on table sales_batch_determination_rule is
  'Which batch a delivery item is picked from, and in what order the batches are taken (SD batch determination). The most specific rule that answers for the customer, the material and the plant wins; a blank position answers for every value of it. Nothing is seeded, so a tenant that maintains no rule picks exactly as it did before.';

comment on column sales_batch_determination_rule.sort_rule is
  'FIFO takes the batch that has stood longest, LIFO the newest, EXPIRY the soonest to expire (FEFO), and BATCH_NUMBER the lowest batch number. A rule that cannot order two batches — two created in the same instant, or two with no expiry date — falls back to batch number, because an unstable order is worse than a plain one.';

create index sales_batch_determination_lookup_ix
  on sales_batch_determination_rule (client, material_number, customer_number, plant);

-- ── The capability ────────────────────────────────────────────────────────
-- Configuration is its own act, as it is everywhere else in this package: the picker who uses a
-- rule is not the person who decides what order the warehouse takes stock in.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.BATCHDETERMINATION.DEFINE', 'CFG', 'BATCHDETERMINATION', false,
  'Maintain batch determination for sales, at /config/batch-determination: the rules that say which batch a delivery item is picked from and in what order — FIFO, LIFO, soonest to expire or lowest batch number — for a customer, a material, a plant or any combination of them, with the most specific rule that answers winning. The rule is read when a pick is confirmed without a batch, so a picker who names a batch keeps it and a picker who names none is told which one to take. Nothing is seeded, so a tenant that maintains no rule picks as it always did.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
