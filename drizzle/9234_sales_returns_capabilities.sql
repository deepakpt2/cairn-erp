-- 9234: the three codes the returns screen gates on.
--
-- A return is worked in three acts, and they are not three permissions on one thing — they are three
-- different kinds of act. Raising a returns order is a commercial claim: no stock moves and nothing is
-- posted. Raising a returns delivery is a warehouse instruction: it promises that goods are coming back,
-- and again nothing moves. Receiving the goods is the movement itself, and it is the one that touches
-- stock. A company in which one clerk raises the complaint and another receives the lorry wants those
-- separated, and a code that lumped them together could not express that.
--
-- The code is declared here because the screen that gates on it is declared here. A capability with no
-- row can never be granted: the screen would ask for a code no role can hold, and every user would be
-- refused by a screen that looks complete — the DI-014 lesson, which is why this migration travels with
-- the screen rather than after it.
--
-- The sales clerk already holds `SALES.*`, and the pattern reaches every code below it, so no grant is
-- written for that role: a pattern is granted once and the codes under it arrive by themselves. The
-- warehouse clerk holds `INV.*`, which does not reach into SALES, so the receipt is granted to that role
-- explicitly — receiving a lorry is a warehouse act, and a returns screen the warehouse cannot work is a
-- screen that sends the goods to a desk that is not there when they arrive.
--
-- None of the three is flagged posting-relevant, and that is a fact about the returns bucket rather than
-- a leniency: the 651 moves goods into stock the company does not value yet, so it writes no accounting
-- document at all. The value arrives later, when the inspected goods are transferred out of returns stock
-- into valuated stock, and that transfer is the movement which posts.

insert into capability (code, module, action, is_posting_relevant, description)
values
  (
    'SALES.RETURNS.ORDER.CREATE', 'SALES', 'CREATE', false,
    'Raise a returns order at /sales/returns: the complaint that names what the customer is sending back, raised against the invoice the goods were billed on and priced from that invoice line rather than priced again. It posts no accounting document and moves no stock. It does not raise the returns delivery, receive goods, or credit the customer.'
  ),
  (
    'SALES.RETURNS.DELIVERY.CREATE', 'SALES', 'CREATE', false,
    'Raise a returns delivery at /sales/returns: the document goods come back on, raised either against the outbound delivery they left on or against a returns order. It is bounded by what was issued and has not already come back, and by what the returns order has not already been given a delivery. It posts nothing. It does not receive the goods, which is SALES.RETURNS.RECEIPT.POST, and it does not credit the customer.'
  ),
  (
    'SALES.RETURNS.RECEIPT.POST', 'SALES', 'POST', false,
    'Receive goods back from a customer at /sales/returns: the 651, which puts them into returns stock. Returns stock is not valuated, so the movement writes no accounting document — the value arrives when the inspected goods are transferred out of returns stock into valuated stock. It does not raise the returns delivery and does not credit the customer.'
  )
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

-- The warehouse receives the lorry. Granted for every tenant that stands; a tenant created from now on
-- gets the same grant from the role catalogue in src/platform/tenancy/index.ts.
insert into role_capability (client, role_code, capability_code)
select c.client, 'WAREHOUSE_CLERK', 'SALES.RETURNS.RECEIPT.POST'
  from public.client c
on conflict do nothing;
