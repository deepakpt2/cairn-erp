-- SCR-080 / R-128 (stage 2): the outgoing payment record remembers its completion.
--
-- The discount taken and the on-account amount stand as totals on
-- the payment record; the per-item truth lives on the KZ journal
-- lines (text and clearing stamps), as with the incoming payment.
alter table public.outgoing_payment
  add column discount_amount numeric(23, 4) not null default 0;
--> statement-breakpoint
alter table public.outgoing_payment
  add column on_account_amount numeric(23, 4) not null default 0;
