-- 9275 — Movement 561: the initial stock entry
--
-- A company's opening stock answers no document. A receipt answers a purchase
-- order, an issue answers an order or a cost centre, a transfer answers nothing
-- but still moves stock the company already owns. Opening stock is there on the
-- day the books open, and there is no document before it.
--
-- Until now the system had no way to say that. The gap was invisible while the
-- only tenant with a history began trading on the day it was created; it stops
-- being invisible the moment a company arrives with shelves that were already
-- full, which is every real migration and every demo that pretends to be one.
--
-- This migration registers the capability that posts the movement. It adds no
-- table: the movement itself is written into the tenant's movement catalogue by
-- the service the first time it posts, the way every other movement is, because
-- movement types belong to a tenant and not to the schema.
--
-- The posting is deliberately narrow. It requires the same authority every
-- goods movement requires — a company-code and a plant restriction — and it
-- values the stock at the price the material already carries, so an opening
-- entry cannot quietly restate what every later movement will cost.

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'INV.INITIAL_STOCK.POST', 'INV', 'CREATE', true,
  'Post an initial stock entry (MIGO 561): the stock a company already holds on the day its books '
  || 'open. Writes a material document, the stock balance, the valuation totals and one balanced '
  || 'journal — stock debited at the material''s own price against retained earnings, with no '
  || 'clearing account because there is nothing to clear. Needs a company-code and a plant '
  || 'restriction, and refuses to span company codes.'
) on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
