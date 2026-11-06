-- 9221: ME21N item invoice control — the second of the two parts.
--
-- Part one put what a receipt may do on the order. This part puts what an invoice may do
-- there, and it is the part that moves money, so every default here is chosen to leave
-- today's books exactly as they stand until somebody decides otherwise on the item.
--
-- Three flags, all mandatory:
--
--   * gr_based_invoice_verification — the invoice is checked against goods received, not
--     against the quantity ordered. It is true by default because true is what the
--     application does today, unconditionally: an item can be invoiced for no more than
--     arrived and was not invoiced yet. Switching it off is what lets a supplier be paid
--     before the goods arrive. That is a change in what the company will pay for, which
--     is why it is a decision taken on one item at a time and never a default.
--
--   * invoice_receipt_indicator — the item is invoiceable at all. True by default, which
--     is today's behaviour. Off, no invoice is posted against the item whatever its
--     quantities say, and the order has to be paid another way.
--
--   * final_invoice_indicator — no further invoices are expected. False by default:
--     nothing is closed retroactively, and the system does not set it on its own when the
--     quantity happens to be met. Closing an item to invoicing is a buyer's claim that
--     the supplier has no further claim, and a claim like that is made by a person.
--
-- No backfill and no derived values: an item that has stood for a year behaves after this
-- migration exactly as it behaved before it.

alter table public.purchase_order_item
  add column if not exists invoice_receipt_indicator boolean not null default true,
  add column if not exists gr_based_invoice_verification boolean not null default true,
  add column if not exists final_invoice_indicator boolean not null default false;

comment on column public.purchase_order_item.invoice_receipt_indicator is
  'Whether the item is invoiceable at all. Off, no invoice is posted against it whatever its quantities say.';
comment on column public.purchase_order_item.gr_based_invoice_verification is
  'The invoice is verified against goods received rather than the quantity ordered. Off, an item can be invoiced before anything arrives — a payment the company makes on the supplier''s word.';
comment on column public.purchase_order_item.final_invoice_indicator is
  'No further invoices are expected against the item. Set by a buyer; never set by posting.';
