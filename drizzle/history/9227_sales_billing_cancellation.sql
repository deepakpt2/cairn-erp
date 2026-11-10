-- 9227: a cancelled billing leaves the delivery billable.
--
-- Cancelling a billing document used to be a door that only opened one way. `billing_document_delivery_uq`
-- allowed one billing document per delivery, and a cancelled row still occupied that slot, so the strict
-- entry point answered "is already billed as <number>" for ever after and the retry entry point answered
-- "stands CANCELLED". One wrong click on cancel therefore voided the revenue for goods that had already
-- left the warehouse, with no route back through Sales: the only way to the customer's money was a finance
-- credit memo typed by hand. The code said so in three places and pointed at DI-020.
--
-- SAP never had this door. Cancelling an invoice (VF11) creates a **cancellation billing document** of the
-- type the original's billing type names as its cancellation type — `S1` for an `F2`. The cancellation
-- document reverses the accounting, the original is linked to it, and the delivery's billing status is
-- reset, so the delivery reappears in the billing due list (VF04) and a corrected document is created
-- against the same delivery and the same order. A cancellation is not a credit memo: a credit memo (`G2`)
-- is a new negative document that stands on its own, while a cancellation is a reversal of one named
-- document, and it can happen once.
--
-- This migration carries all three halves of that.
--
-- **The cancellation type is configuration.** `sales_document_type` gains `cancellation_document_type`: the
-- type a document of this type cancels into. It is nullable because it is genuinely optional — an order
-- type and a delivery type have no cancellation counterpart, and saying so with a sentinel would be a lie.
-- The column carries a composite foreign key to the type it names, so a cancellation type that does not
-- stand cannot be configured.
--
-- **The cancellation document has no lines of its own.** It states which document it cancels and what it
-- reverses, and its accounting act is the cancellation the accounting-invoice service already performs —
-- that service mirrors the original journal line for line, which is where the revenue, the tax and the
-- receivable were determined in the first place. Copying the lines into a second document would create a
-- second set of rows claiming to describe the same delivered quantities, all of them required to stay in
-- step with the original for no reader's benefit. The credit memo (G2) that arrives with the returns work
-- will carry lines, because a credit memo describes goods rather than undoing a document.
--
-- **The one-billing-per-delivery rule survives, narrowed to what it was for.** The absolute unique index
-- becomes a partial one: a document that has been cancelled no longer occupies the delivery's slot, and
-- neither does a document that stands against another one — a cancellation or a credit memo — because the
-- document it stands against already did. Two *live* billing documents for one delivery remain structurally
-- impossible, which is the overbilling the index was written to prevent. A second cancellation of the same
-- document is likewise impossible, by a second partial index on `cancellation_of`; there is no index on
-- `credit_of`, because a customer may legitimately hold two credit memos against one invoice.
--
-- The cancellation type and the number interval its documents draw from are seeded for every tenant that
-- already stands, and for every tenant created from now on.

alter table public.sales_document_type
  add column cancellation_document_type varchar(4);

alter table public.sales_document_type
  add constraint sales_document_type_cancellation_fk
  foreign key (client, cancellation_document_type)
  references public.sales_document_type (client, document_type);

comment on column public.sales_document_type.cancellation_document_type is
  'The type a document of this type cancels into — S1 for F2, as VF11 uses. Null where the type has no cancellation counterpart, which is true of an order and of a delivery: nothing is undone by a second document there.';

-- The cancellation type itself, for every tenant.
insert into public.sales_document_type (
  client, document_type, name, number_range_object, number_range_sub_object, created_by
)
select c.client, 'S1', 'Cancellation of invoice', 'BILLING', 'S1', 'MIGRATION'
  from public.client c
on conflict (client, document_type) do nothing;

-- What an invoice cancels into.
update public.sales_document_type
   set cancellation_document_type = 'S1',
       changed_by = 'MIGRATION',
       changed_at = now()
 where document_type = 'F2';

-- The interval those documents draw their numbers from, for every tenant, matching what defineRange writes
-- for a tenant created from now on.
insert into public.number_range (
  client, object_code, company_code, sub_object, fiscal_year, prefix,
  from_number, to_number, current_number, number_length, display_style, is_external, created_by
)
select c.client, 'BILLING', '*', 'S1', 0, 'CN', 1, 999999, 0, 7, 'READABLE', false, 'MIGRATION'
  from public.client c
on conflict do nothing;

alter table public.billing_document
  add column cancellation_of varchar(20);

comment on column public.billing_document.cancellation_of is
  'Set only on a cancellation document: the billing document this one cancels, named once and never twice. The link reads the same way as a credit memo''s credit_of, but the two are different acts and only this one is unique.';
comment on column public.billing_document.credit_of is
  'The document this one stands against: a credit memo names the invoice it credits. A cancellation uses cancellation_of instead, because a credit memo may stand more than once against one invoice and a cancellation may not.';

-- One live billing document per delivery, where "live" now means what it was always meant to mean.
drop index if exists billing_document_delivery_uq;
create unique index billing_document_delivery_live_uq
  on public.billing_document (client, delivery_number)
  where status <> 'CANCELLED' and credit_of is null and cancellation_of is null;

-- A document is cancelled once.
create unique index billing_document_cancellation_uq
  on public.billing_document (client, cancellation_of)
  where cancellation_of is not null;

-- A document that stands on its own carries a value that is not negative. A cancellation carries the value it
-- reverses, sign and all, so the two of them sum to nothing and neither has to be read twice to be
-- understood. Saying it in the constraint rather than in the service is what keeps a future writer — a
-- correction screen, an import, a second cancellation path — from filing a cancellation with a value that
-- quietly adds to the customer's balance instead of clearing it.
alter table public.billing_document
  drop constraint billing_document_value_ck;

alter table public.billing_document
  add constraint billing_document_value_ck check (
    (cancellation_of is null     and net_value >= 0 and tax_value >= 0 and gross_value >= 0)
    or
    (cancellation_of is not null and net_value <= 0 and tax_value <= 0 and gross_value <= 0)
  );

-- The same narrowing, one level down. "A delivered line earns one billing line, ever" was true while a
-- document could not be re-billed; a corrected document writes its own lines against the same delivered
-- lines, and the cancelled document's lines stay where they are. What still has to hold is that a delivered
-- line is billed once *by the one live document that bills its delivery* — and that is the header's index,
-- not this one. Scoped to the document, the index keeps its real job: no document bills the same delivered
-- line twice.
drop index if exists billing_document_line_delivery_line_uq;
create unique index billing_document_line_delivery_line_uq
  on public.billing_document_line (client, billing_number, delivery_line_number);

comment on table public.billing_document_line is
  'One item of a billing document — VBRP. The quantity is what was goods-issued on the delivery item it names, the price and the condition record are read from the order line behind it, and a delivered line is billed once by the one live document that bills its delivery (billing_document_delivery_live_uq); no document bills the same delivered line twice (billing_document_line_delivery_line_uq). A cancellation document carries no lines: it reverses a document, and the journal it mirrors holds the lines.';
