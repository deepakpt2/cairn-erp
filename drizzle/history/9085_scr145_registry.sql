-- SCR-145: the return delivery capability and its registry term.
--
-- MBRL is a reference identifier offered as a lookup courtesy (§19.5 AI-05); the code is ours.

INSERT INTO capability (code, module, description, action, is_posting_relevant)
VALUES
  ('INV.RETURN.POST', 'INV',
   'Post a return delivery of goods received against a purchase order: derived returnable quantity, exact stock dimension, receipt and order lineage, GR/IR reopened, no vendor liability touched',
   'POST', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier,
   route_path, conformance_tier, created_by)
VALUES
  (gen_random_uuid()::text, 'INV.RETURN.POST', 'material_document_line',
   'Return delivery to a vendor', 'TRANSACTION', 'INV',
   'Return goods that arrived against a purchase order. The reference is a posted goods receipt, named by its number and fiscal year; every item states what was received, what has already gone back and what may still be returned, and only the return quantity is entered. The receipt is never cancelled — it stands, and the received position on the order falls by what went back. The return posts its own material document through the canonical engine and numbering service, carrying the original document, its year and its line, so a return and a cancellation stay distinguishable. The movement is configuration (RETURN_TO_VENDOR, direction ISSUE, counter RETURN_TO_VENDOR_REV): a movement that adds stock cannot post as a return. Stock is judged on the exact material, plant, storage location and stock type after the locks are taken and the returnable quantity is re-read, and the posting block reaches this writer like every other. Accounting mirrors the receipt: inventory is credited, GR/IR is debited and the price difference posts where the order price and the stock value disagree, reopening the clearing position the later credit memo closes — no vendor liability is touched and no credit memo is created. Batch, serial numbers, split valuation, special stock and outbound delivery are refused by name, because this canon carries no structure for them.',
   'TIER_1_BUILT', '/inventory/return-delivery', 'B', 'SCR145_MIGRATION')
ON CONFLICT (our_code) DO NOTHING;

INSERT INTO term_alias (id, external_system, alias, term_id, created_by)
SELECT gen_random_uuid()::text, 'REFERENCE_ERP', 'MBRL', t.id, 'SCR145_MIGRATION'
FROM term_registry t WHERE t.our_code = 'INV.RETURN.POST'
ON CONFLICT (external_system, alias) DO NOTHING;
