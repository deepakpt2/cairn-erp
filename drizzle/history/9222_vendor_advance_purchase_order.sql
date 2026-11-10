-- 9222: an advance may be raised against a purchase order.
--
-- A vendor advance has always stood free of any order: it belongs to the vendor, and when
-- the invoice arrives the two are set against each other in the clearing. That is right for
-- a standing deposit, but wrong for the ordinary case, where a supplier asks for part of
-- the money up front against one particular order. Nobody could then say which order the
-- money was for, or how much of it was still unspent when the invoice came in.
--
-- So an advance may now name the order it was raised for. Two rules decide everything
-- else:
--
--   * the order must belong to the vendor and the company the advance is posted in. An
--     advance is money given to a supplier against a commitment made to that supplier, and
--     pointing it at somebody else's order would be a way to spend it twice.
--
--   * naming nothing stays legal. A general deposit against a vendor is not an error, it is
--     a different thing, and the clearing that exists today already settles it.
--
-- No backfill: an advance raised before this migration has no order, which is exactly what
-- "no order" means, and it keeps settling the way it always has.

alter table public.vendor_down_payment_request
  add column if not exists purchase_order varchar(20);

alter table public.vendor_down_payment
  add column if not exists purchase_order varchar(20);

comment on column public.vendor_down_payment_request.purchase_order is
  'The purchase order this advance is raised against, when it is raised against one. Null is a general advance for the vendor.';
comment on column public.vendor_down_payment.purchase_order is
  'The purchase order this advance was paid against, when one was named. Null is a general advance for the vendor.';

create index if not exists vendor_down_payment_order_idx
  on public.vendor_down_payment (client, purchase_order)
  where purchase_order is not null;

create index if not exists vendor_down_payment_request_order_idx
  on public.vendor_down_payment_request (client, purchase_order)
  where purchase_order is not null;
