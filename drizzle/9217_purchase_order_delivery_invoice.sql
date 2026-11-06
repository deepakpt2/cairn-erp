-- ME21N keeps payment terms and the incoterms on a single header tab, "Delivery/Invoice",
-- and defaults them from the vendor master. The purchase order carried none of the three,
-- so a buyer could state who supplies what but not on what terms it is delivered or paid.
--
-- The names, lengths and treatment follow the purchase contract, which has carried all
-- three since it was built: payment terms are checked against the tenant payment-terms
-- master in the module rather than by a foreign key, and the incoterms are the standard
-- eleven codes with a free-text place. All three are nullable — an order can be raised
-- before its terms are settled.

alter table public.purchase_order
  add column if not exists payment_terms_code varchar(12),
  add column if not exists incoterms_code varchar(3),
  add column if not exists incoterms_location varchar(160);
