-- ---------------------------------------------------------------------------
-- SCR-039 / OBA4 stage 2 — the employee tolerance group registry
--
-- The design has planned posting tolerances since its table inventory
-- (tolerance_group and tolerance_key, reference T043/T043S) without ever
-- building them, and the screens that came before this one closed without
-- the table mattering: nothing delivered tolerance groups the way the
-- standard package delivers document types, and no posting reads them yet.
-- This migration creates the registry the contract settled (R-88) in the
-- product's own shape: `employee_tolerance_group`, keyed by company code
-- and group, both key parts allowed blank as deliberate stored values —
-- a blank company code is the tenant-wide scope standing under every
-- company code of the tenant, and a blank group key is the default group
-- of its scope, the baseline for users with no explicit assignment — so
-- neither blank can hide behind a foreign key, and a named company code
-- standing in the tenant is the service's to judge (stage 3).
--
-- The limits are exact decimals at the package widths: per document
-- (15,2), per line item (13,2), cash discount percentage (5,3, within
-- 0–100), and the payment-difference tolerances, amounts (7,2) and
-- percentages (3,1, within 0–99.9), defaulting to zero on the four
-- optional fields. Zero is a stored meaning, not a missing value: it
-- says this check imposes no ceiling. The one cross-field rule — the
-- line-item ceiling judged against the document ceiling only when both
-- stand non-zero, because a zero on either side switches that side off —
-- is stated here as well as in the service, so no writer at any layer can
-- store a line ceiling a document ceiling would already have refused.
--
-- Deletion does not exist for this registry (R-88): a group becomes
-- removable when user assignment exists to be checked. The table
-- therefore carries no lifecycle columns beyond the audit pair, and no
-- deletion path is built against it.
--
-- Nothing here can refuse: the table is new, and no existing row can
-- violate a rule it predates.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employee_tolerance_group (
  client                      varchar(4)    NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  company_code                varchar(10)   NOT NULL DEFAULT '',
  group_key                   varchar(4)    NOT NULL DEFAULT '',
  max_document_amount         numeric(15,2) NOT NULL,
  max_line_amount             numeric(13,2) NOT NULL,
  max_cash_discount_percent   numeric(5,3)  NOT NULL,
  payment_diff_revenue_amount numeric(7,2)  NOT NULL DEFAULT 0,
  payment_diff_expense_amount numeric(7,2)  NOT NULL DEFAULT 0,
  payment_diff_revenue_percent numeric(3,1) NOT NULL DEFAULT 0,
  payment_diff_expense_percent numeric(3,1) NOT NULL DEFAULT 0,
  created_by                  varchar(60)   NOT NULL DEFAULT 'SYSTEM',
  created_at                  timestamptz   NOT NULL DEFAULT now(),
  changed_by                  varchar(60),
  changed_at                  timestamptz,
  CONSTRAINT employee_tolerance_group_pk PRIMARY KEY (client, company_code, group_key),
  CONSTRAINT employee_tolerance_group_company_format CHECK (company_code ~ '^([A-Z0-9]{4})?$'),
  CONSTRAINT employee_tolerance_group_key_format CHECK (group_key ~ '^([A-Z0-9]{1,4})?$'),
  CONSTRAINT employee_tolerance_group_amount_bounds CHECK (
    max_document_amount >= 0 AND max_line_amount >= 0
    AND payment_diff_revenue_amount >= 0 AND payment_diff_expense_amount >= 0
  ),
  CONSTRAINT employee_tolerance_group_discount_bounds CHECK (max_cash_discount_percent BETWEEN 0 AND 100),
  CONSTRAINT employee_tolerance_group_diff_percent_bounds CHECK (
    payment_diff_revenue_percent BETWEEN 0 AND 99.9
    AND payment_diff_expense_percent BETWEEN 0 AND 99.9
  ),
  CONSTRAINT employee_tolerance_group_line_within_document CHECK (
    max_line_amount = 0 OR max_document_amount = 0 OR max_line_amount <= max_document_amount
  )
);

-- The lookup this registry serves: a company code's groups (and the
-- tenant-wide scope's) are found by the primary key's prefix; this index
-- backs the same read across scopes.
CREATE INDEX IF NOT EXISTS employee_tolerance_group_company_idx
  ON employee_tolerance_group (client, company_code);
