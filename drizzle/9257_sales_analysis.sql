-- §5.3 (audit gaps E1, E2): sales analysis — sales, backlog, returns, margin.
--
-- No tables. An analysis is a reading of the documents Phases 1 to 4 wrote, grouped the way the
-- business asks about them. A number that is copied into a cube is a number that can disagree with
-- the document it came from, and an analysis is read by people who will not open the document to
-- check.
--
-- SAP answers these four questions with information structures (MC+I, MCTA) fed from the billing
-- documents, and with the order backlog kept as an open quantity rather than as a balance. This
-- package answers them with queries over the same documents, for the same reason the register does
-- (9256): there is one record of what happened, and it is the document.
--
-- Three things the analysis owes a reader, and which are why it is not a report somebody wrote once:
--
-- **Money is never added across currencies.** Every row carries its currency and the totals are
-- reported once per currency. A single total over USD and EUR is not a number.
--
-- **Cost is reported only where a cost stands.** The margin is read from the statistical cost
-- condition Phase 2 carries on the document line. A line priced by a procedure with no cost
-- condition has no cost, and the row says so rather than printing a margin equal to its revenue.
--
-- **The arithmetic has one author.** The backlog's delivered quantity is read with the same join
-- fulfillment-quantities.ts uses, because that module is what the delivery and billing services use
-- to refuse things. An analysis that called a line open when the delivery service calls it drawn
-- down would be worse than no analysis.

-- ── The capability ──────────────────────────────────────────────────────────
-- One, because reading is not four acts. It is deliberately not posting-relevant: an analysis posts
-- nothing, decides nothing and changes nothing, and the screen offers no button that would.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.ANALYSIS.LIST', 'SALES', 'ANALYSIS', false,
  'Sales analysis, at /sales/analysis (SAP MC+I, MCTA): what was sold, what is still to come, what came back and what it earned — grouped by customer, material, sales organisation, document type or period, and bucketed by month, quarter or year over a window the reader names. Read from the documents that stand rather than from a copy of them, so every figure ties to the billing register and through it to the ledger. Money is never added across currencies: each row carries its own and the totals are reported once per currency. The margin is read from the statistical cost condition the pricing carried, and is left empty rather than guessed where a line was priced without one. An analysis posts nothing: it reads.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
