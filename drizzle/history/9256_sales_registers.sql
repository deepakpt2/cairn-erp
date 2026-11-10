-- §5.2 (audit gaps E1, E2, E3): the registers and the due lists.
--
-- No tables. The register reads what Phases 1 to 4 wrote, and the reason it needs no schema is the
-- point: a register is a *reading* of documents that stand, not a new kind of document.
--
-- SAP's VA05, VL06 and VF05 answer three questions — what was ordered, what went out, what was
-- billed — and a fourth and fifth that this package has had no screen for at all: what came back,
-- and what was undone. They are registers rather than lists because they are filtered by what the
-- business asks about — the customer, the material, the sales organisation, the plant, the type, the
-- status and a period — and because they say what they found and what they did not bother to count.
--
-- The two due lists are not restated by the register. It asks the same services the delivery and the
-- billing screens ask, and gives them the same filter, because a register that disagreed with the
-- act it is listing would be worse than no register at all.

-- ── The capability ──────────────────────────────────────────────────────────
-- One, because reading is not two acts. It is deliberately not posting-relevant: a register posts
-- nothing, decides nothing and changes nothing, and the screen offers no button that would.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.DOCUMENTS.LIST', 'SALES', 'DOCUMENTS', false,
  'The sales registers, at /sales/documents (SAP VA05, VL06, VF05): what stands, by document kind — sales orders, deliveries, billing documents, returns and cancellations — filtered by customer, material, sales organisation, plant, document type, status and period, with the totals of what the register answered and a plain statement of where the read was cut. The delivery and billing due lists are read here too, through the same services the delivery and billing screens use and under the same filter, so what a planner sees is what the act will do. A register posts nothing: it reads.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
