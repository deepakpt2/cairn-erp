-- SCR-028 / FS00 stage 2: G/L account master data model.
--
-- Owner contract (B-216) and the four decisions settled with it (R-51/D-123), plus the
-- `MITKZ` ruling (R-52/D-124). Three new tables:
--
--   gl_account_group               Account Group registry (`KTOKS`), chart-scoped:
--                                  number range, description, lifecycle, version.
--   gl_account_group_field_status  the (group, field, status) matrix deciding
--                                  Suppress / Optional / Mandatory per field. The
--                                  screen renders entirely from it, so a consultant
--                                  can tighten a group without a release.
--   group_chart_accounts           group-side account master for consolidation
--                                  roll-up, with its foreign key to the OB13 registry.
--                                  Built now, without maintenance UI, so its F4
--                                  legitimately starts empty.
--
-- `gl_account` gains the contracted fields and splits its single legacy block flag into
-- a posting block (`XSPEB`) and a creation block (`XSPEA`). `MITKZ` moves to the
-- contracted plural vocabulary and keeps `MATERIAL` as a fourth value: four accounts
-- carry it and the reference indicator covers materials as well as the three
-- subledgers, so migrating them away would rewrite an account into a subledger it does
-- not belong to.
--
-- `is_balance_sheet` is derived, never supplied freely: it is restated from the G/L
-- Account Type (`XBILK`) and pinned by a check so the stored flag cannot drift from the
-- indicator the screen shows. Existing data already agrees on every row, so the
-- restatement changes no value — it makes the invariant enforceable.
--
-- Account numbers stay strictly immutable. The primary key is unchanged and nothing
-- here rewrites a number; a different number is a different account.

DO $$
DECLARE
  unknown_reconciliation text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'gl_account_group'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION '0036 refuses to recreate gl_account_group: the Account Group registry already exists';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'gl_account' AND column_name = 'is_blocked' AND table_schema = current_schema()
  ) IS NOT TRUE THEN
    RAISE EXCEPTION '0036 refuses to run: gl_account.is_blocked is missing, so the block split has nothing to migrate';
  END IF;

  -- Only values this migration knows how to map may be present. Anything else would
  -- survive the rewrite and fail the new vocabulary check with a less useful message.
  SELECT reconciliation_type INTO unknown_reconciliation
  FROM gl_account
  WHERE reconciliation_type IS NOT NULL
    AND reconciliation_type NOT IN ('CUSTOMER', 'VENDOR', 'ASSET', 'MATERIAL', 'CUSTOMERS', 'VENDORS', 'ASSETS')
  LIMIT 1;
  IF unknown_reconciliation IS NOT NULL THEN
    RAISE EXCEPTION '0036 refuses to migrate reconciliation_type: % is not a value this migration knows how to map', unknown_reconciliation;
  END IF;

  IF EXISTS (
    SELECT 1 FROM gl_account WHERE account_number !~ '^[A-Za-z0-9]{1,10}$'
  ) THEN
    RAISE EXCEPTION '0036 refuses to add the account-number format check: an existing account number is not alphanumeric within ten characters';
  END IF;
END $$;

/* ── 1 · Account Group registry ────────────────────────────────────────────── */

CREATE TABLE gl_account_group (
  client varchar(4) NOT NULL,
  chart_of_accounts varchar(4) NOT NULL,
  account_group varchar(4) NOT NULL,
  description varchar(50) NOT NULL,
  from_account_number varchar(10) NOT NULL,
  to_account_number varchar(10) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT gl_account_group_pk
    PRIMARY KEY (client, chart_of_accounts, account_group),
  CONSTRAINT gl_account_group_key_format
    CHECK (account_group ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT gl_account_group_description_nonempty
    CHECK (length(btrim(description)) BETWEEN 1 AND 50),
  CONSTRAINT gl_account_group_number_format
    CHECK (from_account_number ~ '^[A-Za-z0-9]{1,10}$'
      AND to_account_number ~ '^[A-Za-z0-9]{1,10}$'),
  -- Ranges are compared right-padded to the full account-number width, which is how a
  -- character range is read on the screen: `0010`–`0099` must never swallow `1000`.
  CONSTRAINT gl_account_group_range_ordered
    CHECK (rpad(from_account_number, 10, '0') <= rpad(to_account_number, 10, '0')),
  CONSTRAINT gl_account_group_client_fk
    FOREIGN KEY (client) REFERENCES client (client)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT gl_account_group_client_chart_fk
    FOREIGN KEY (client, chart_of_accounts)
    REFERENCES chart_of_accounts (client, chart_of_accounts)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX gl_account_group_active_idx
  ON gl_account_group (client, chart_of_accounts, is_active, account_group);

/* ── 2 · Field status matrix ───────────────────────────────────────────────── */

CREATE TABLE gl_account_group_field_status (
  client varchar(4) NOT NULL,
  chart_of_accounts varchar(4) NOT NULL,
  account_group varchar(4) NOT NULL,
  field_key varchar(32) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'OPTIONAL',
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT gl_account_group_field_status_pk
    PRIMARY KEY (client, chart_of_accounts, account_group, field_key),
  CONSTRAINT gl_account_group_field_status_status
    CHECK (status IN ('SUPPRESS', 'OPTIONAL', 'MANDATORY')),
  -- The twelve matrix-controlled fields, exactly as GL_ACCOUNT_FIELDS lists them in
  -- src/app/config/gl-accounts/fieldStatus.ts; a contract test keeps the two in step.
  -- `account_number`, `chart_of_accounts` and `account_group` are absent on purpose:
  -- without them there is no record to store, so no group may suppress them.
  -- `is_balance_sheet` is derived and never entered, so there is nothing to suppress.
  CONSTRAINT gl_account_group_field_status_field
    CHECK (field_key IN (
      'name',
      'accountType',
      'glAccountType',
      'isOpenItemManaged',
      'reconciliationType',
      'requiresCostObject',
      'isTaxRelevant',
      'groupAccountNumber',
      'languageKey',
      'sortKey',
      'isBlockedPosting',
      'isBlockedCreation'
    )),
  CONSTRAINT gl_account_group_field_status_client_fk
    FOREIGN KEY (client) REFERENCES client (client)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT gl_account_group_field_status_group_fk
    FOREIGN KEY (client, chart_of_accounts, account_group)
    REFERENCES gl_account_group (client, chart_of_accounts, account_group)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

/* ── 3 · Group-side account master ─────────────────────────────────────────── */

CREATE TABLE group_chart_accounts (
  client varchar(4) NOT NULL,
  group_chart_of_accounts varchar(4) NOT NULL,
  group_account_number varchar(10) NOT NULL,
  name varchar(200) NOT NULL,
  account_type varchar(16) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT group_chart_accounts_pk
    PRIMARY KEY (client, group_chart_of_accounts, group_account_number),
  CONSTRAINT group_chart_accounts_number_format
    CHECK (group_account_number ~ '^[A-Za-z0-9]{1,10}$'),
  CONSTRAINT group_chart_accounts_name_nonempty
    CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  CONSTRAINT group_chart_accounts_type_vocabulary
    CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  CONSTRAINT group_chart_accounts_client_fk
    FOREIGN KEY (client) REFERENCES client (client)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT group_chart_accounts_registry_fk
    FOREIGN KEY (client, group_chart_of_accounts)
    REFERENCES group_chart_of_accounts (client, group_chart_of_accounts)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX group_chart_accounts_active_idx
  ON group_chart_accounts (client, group_chart_of_accounts, is_active, group_account_number);

/* ── 4 · G/L account master fields ─────────────────────────────────────────── */

ALTER TABLE gl_account
  ADD COLUMN account_group varchar(4),
  ADD COLUMN gl_account_type varchar(16) NOT NULL DEFAULT 'BALANCE_SHEET',
  ADD COLUMN group_account_number varchar(10),
  ADD COLUMN language_key varchar(2) NOT NULL DEFAULT 'EN',
  ADD COLUMN sort_key varchar(3) NOT NULL DEFAULT '000',
  ADD COLUMN is_blocked_posting boolean NOT NULL DEFAULT false,
  ADD COLUMN is_blocked_creation boolean NOT NULL DEFAULT false;

-- Derived and contracted values restated from what is already stored.
UPDATE gl_account SET
  gl_account_type = CASE
    WHEN account_type IN ('ASSET', 'LIABILITY', 'EQUITY') THEN 'BALANCE_SHEET'
    ELSE 'PL_STATEMENT'
  END,
  is_balance_sheet = account_type IN ('ASSET', 'LIABILITY', 'EQUITY'),
  reconciliation_type = CASE reconciliation_type
    WHEN 'CUSTOMER' THEN 'CUSTOMERS'
    WHEN 'VENDOR' THEN 'VENDORS'
    WHEN 'ASSET' THEN 'ASSETS'
    ELSE reconciliation_type
  END,
  -- The legacy flag meant "this account may not be used", which is what both blocks
  -- express separately from FS00 onward. No row is currently blocked.
  is_blocked_posting = is_blocked,
  is_blocked_creation = is_blocked;

-- Accounts predating the registry still need a group, because `account_group` is
-- mandatory. One permissive group per chart is the honest backfill: the seeded
-- standard chart spans three leading digits for expenses and two for revenue, so no
-- per-account-type range describes it. The range is taken from the chart's own
-- account-number length (OB13 `KTKTB`), and a consultant may define narrower groups
-- and re-assign accounts in Change mode afterwards.
INSERT INTO gl_account_group (
  client, chart_of_accounts, account_group, description,
  from_account_number, to_account_number, created_by
)
SELECT
  accounts.client,
  accounts.chart_of_accounts,
  'GENL',
  'General ledger accounts',
  repeat('0', chart.account_number_length),
  repeat('9', chart.account_number_length),
  'SYSTEM'
FROM (SELECT DISTINCT client, chart_of_accounts FROM gl_account) accounts
  JOIN chart_of_accounts chart
    ON chart.client = accounts.client
    AND chart.chart_of_accounts = accounts.chart_of_accounts
ON CONFLICT DO NOTHING;

UPDATE gl_account SET account_group = 'GENL' WHERE account_group IS NULL;

ALTER TABLE gl_account
  ALTER COLUMN account_group SET NOT NULL;

ALTER TABLE gl_account
  ADD CONSTRAINT gl_account_number_format
    CHECK (account_number ~ '^[A-Za-z0-9]{1,10}$'),
  ADD CONSTRAINT gl_account_type_vocabulary
    CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  ADD CONSTRAINT gl_account_gl_account_type_vocabulary
    CHECK (gl_account_type IN ('BALANCE_SHEET', 'PL_STATEMENT')),
  ADD CONSTRAINT gl_account_reconciliation_vocabulary
    CHECK (reconciliation_type IS NULL
      OR reconciliation_type IN ('CUSTOMERS', 'VENDORS', 'ASSETS', 'MATERIAL')),
  ADD CONSTRAINT gl_account_balance_sheet_derived
    CHECK (is_balance_sheet = (gl_account_type = 'BALANCE_SHEET')),
  ADD CONSTRAINT gl_account_language_format
    CHECK (language_key ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT gl_account_language_supported
    CHECK (language_key IN ('EN')),
  ADD CONSTRAINT gl_account_sort_key_format
    CHECK (sort_key ~ '^[A-Za-z0-9]{3}$'),
  ADD CONSTRAINT gl_account_client_group_fk
    -- No cascade on delete: a group that accounts belong to may be deactivated but
    -- not removed, so the reference itself is what keeps the registry honest.
    FOREIGN KEY (client, chart_of_accounts, account_group)
    REFERENCES gl_account_group (client, chart_of_accounts, account_group)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- `group_account_number` gets no declarative foreign key. The group chart an account
-- rolls up to is resolved through chart_of_accounts.group_chart rather than stored on
-- the account, so there is no column pair a constraint could reference; the service
-- layer validates the number against the chart's resolved group registry instead.
ALTER TABLE gl_account
  DROP COLUMN is_blocked;

CREATE INDEX gl_account_group_idx
  ON gl_account (client, chart_of_accounts, account_group);

CREATE INDEX gl_account_group_account_idx
  ON gl_account (client, group_account_number)
  WHERE group_account_number IS NOT NULL;
