-- 9235: the three codes the credit memo request screen gates on.
--
-- A credit memo is money leaving the company, and the gap this closes is not the document — the G2 has
-- stood since 9231 — it is the act between asking and giving. Since 9232 the complaint is recorded as a
-- credit memo request that is created **held**: it carries a billing block, and no credit can be raised
-- from it until somebody releases that block. The block is the control, and a control nobody is
-- accountable for is a formality rather than a control.
--
-- So the three acts carry three codes, and the separation between them is the point:
--
-- `SALES.CREDIT.REQUEST.CREATE` — raise the complaint. This is not agreeing to it.
-- `SALES.CREDIT.RELEASE` — release the block. This is the act that says somebody with the authority to
--   give the money away has agreed to it, and it is the one the change history should name.
-- `SALES.CREDIT.MEMO.POST` — raise and post the credit itself. By then the request has bounded the
--   quantity and the release has authorised it, so this is the billing act and nothing more.
--
-- No role grant is written here, and that is deliberate. The sales clerk already reaches all three
-- through the `SALES.*` pattern it holds — the same way it reaches cancellation and the order credit
-- release, which are authority acts of exactly this kind. What the three codes buy is that an
-- installation which wants the complaint raised by sales and the release given by finance can grant
-- them separately; one code could not express that, and a company that cannot split them has no choice
-- but to trust one clerk with the whole cycle.
--
-- The first two are not posting-relevant, and that is a fact rather than a leniency: raising the
-- complaint writes a document that is held, and releasing the block only changes a document's state —
-- neither can create or change a financial record. The third one is, because it can: create and post
-- ride one code here exactly as they do for the invoice, and `SALES.BILLING.CREATE` is flagged the same
-- way for the same reason. The distinction the flag draws is what a *financial* record is, not whether
-- an act is important — the release is the more consequential of the two and it is the one that posts
-- nothing.

insert into capability (code, module, action, is_posting_relevant, description)
values
  (
    'SALES.CREDIT.REQUEST.CREATE', 'SALES', 'CREATE', false,
    'Raise a credit memo request at /sales/credit-memo-request: the complaint that names which invoiced lines the customer disputes, and how much of each. It is created held, with a billing block naming why, and no credit can be raised from it until the block is released. It posts no accounting document. It does not release the block and does not credit the customer.'
  ),
  (
    'SALES.CREDIT.RELEASE', 'SALES', 'APPROVE', false,
    'Release the billing block on a credit memo request at /sales/credit-memo-request: the act that says somebody with the authority to give the money away has agreed to the complaint. It is bound by the version the document was read at, and it is recorded in the change history against the user who released it. Releasing is not raising the credit: that is SALES.CREDIT.MEMO.POST.'
  ),
  (
    'SALES.CREDIT.MEMO.POST', 'SALES', 'POST', true,
    'Raise and post the credit memo at /sales/credit-memo-request: the G2 that gives the customer their money back, priced from the line the goods were invoiced at and bounded by the credit memo request it is raised from. A request that still stands blocked is refused by name. It does not release the block, which is SALES.CREDIT.RELEASE.'
  )
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
