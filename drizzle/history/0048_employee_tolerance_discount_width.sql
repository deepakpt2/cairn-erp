-- ---------------------------------------------------------------------------
-- SCR-039 / OBA4 stage 2 — the cash discount column learns to hold 100.000
--
-- Migration 0047 created max_cash_discount_percent at the package's
-- literal width numeric(5,3). Exercising the checks against the real
-- table caught what the schema alone did not say: PostgreSQL's (5,3)
-- tops out at 99.999, so the contract's ceiling of 100.000 per cent
-- (R-88, the package's stated range) could never be stored — the value
-- would be refused by the column's arithmetic overflow before the
-- 0–100 check could ever speak. The check carries the bound; the width
-- must carry the value. The column widens to numeric(6,3), which holds
-- 100.000 plainly while the check continues to refuse anything above.
--
-- A separate migration rather than an edit to 0047: applied migrations
-- are checksum-verified and never rewritten (the rule every migration
-- here obeys), and a fresh database now arrives at the corrected width
-- by applying both in order. Widening a numeric can refuse nothing and
-- rewrites no value.
-- ---------------------------------------------------------------------------

ALTER TABLE employee_tolerance_group
  ALTER COLUMN max_cash_discount_percent TYPE numeric(6,3);
