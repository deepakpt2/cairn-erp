-- 9223: a clearing can name the invoice it settles.
--
-- The clearing journal has always stood as the truth of an advance settlement, and it still
-- does: it carries a `Settles <document>` line for every invoice it clears. What it could not
-- answer, without reading the journal back, was *which purchase-order invoice* a settlement
-- belonged to — and an invoice that arrived through invoice verification is a named thing,
-- with a number of its own, that people ask about by name.
--
-- So the clearing record now names the supplier invoice it settles and, where the advance was
-- raised against an order, the order itself. Two properties matter:
--
--   * both stay nullable, because they are genuinely optional. A clearing entered from the
--     finance clearing screen settles an open item that may have no order behind it at all.
--     Null is not a legacy value here; it is the answer for a clearing that names no order.
--
--   * neither is a balance. The journal stands as the accounting truth; these columns are the
--     reference that lets the invoice screen say what it settled, and lets a cancellation find
--     the settlements it has to undo.
--
-- No backfill: a clearing posted before this migration settled invoices its own way, and the
-- journal lines it wrote still name them.
alter table public.vendor_down_payment_clearing
  add column if not exists invoice_number varchar(20);

alter table public.vendor_down_payment_clearing
  add column if not exists purchase_order varchar(20);

comment on column public.vendor_down_payment_clearing.invoice_number is
  'The supplier invoice this clearing settles, when it was raised from invoice verification. Null is a clearing entered against an open item.';
comment on column public.vendor_down_payment_clearing.purchase_order is
  'The purchase order behind the settlement, when the advance named one. Null is a general advance for the vendor.';

create index if not exists vendor_down_payment_clearing_invoice_idx
  on public.vendor_down_payment_clearing (client, invoice_number)
  where invoice_number is not null;

create index if not exists vendor_down_payment_clearing_order_idx
  on public.vendor_down_payment_clearing (client, purchase_order)
  where purchase_order is not null;
