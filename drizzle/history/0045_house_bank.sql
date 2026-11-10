-- ---------------------------------------------------------------------------
-- SCR-037 / FI12 stage 2 — the tenant's own banks and their accounts
--
-- A house bank is the tenant's bank inside a company code; the accounts
-- under it are where the money is. The bank it names lives in the global
-- bank master (SCR-036, migration 0044), and these tables hold only the
-- reference — country and key, held by foreign key, because a house bank
-- naming a bank that does not exist displays facts nobody defined. The
-- name, city and SWIFT code are read from the master at display time and
-- stored nowhere here, so correcting them in the master corrects every
-- house bank that names the bank.
--
-- The keys are the house-bank key within its company code and the account
-- ID within its house bank, five upper-case letters or digits each (R-86).
-- Both are immutable: renaming either is create + delete, the way every
-- registry key in this product behaves.
--
-- An account carries the local account number (eighteen characters, the
-- owner's package width), an optional IBAN — up to thirty-four, because a
-- Kuwait IBAN is thirty and cannot fit in eighteen (R-86) — a currency
-- held to the currency master by the service, as the exchange rates hold
-- theirs, and the G/L account its postings clear through. That the G/L
-- account is an asset balance-sheet account of the company code's chart is
-- a service rule (R-86): it reads two other tables, and a check constraint
-- here could only lie about having verified it.
--
-- Deleting a house bank while accounts stand is refused by the service,
-- which can say how many and why; the foreign key below restricts it at
-- the database too, so no path removes a bank out from under its accounts.
--
-- Nothing here can refuse: the tables are new, and no existing row can
-- violate a rule it predates.
-- ---------------------------------------------------------------------------

-- A. The house banks. ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS house_bank (
  client         varchar(4)  NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  company_code   varchar(10) NOT NULL,
  house_bank_key varchar(5)  NOT NULL,
  bank_country   char(2)     NOT NULL,
  bank_key       varchar(15) NOT NULL,
  created_by     varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     varchar(60),
  changed_at     timestamptz,
  CONSTRAINT house_bank_pk PRIMARY KEY (client, company_code, house_bank_key),
  CONSTRAINT house_bank_company_fk FOREIGN KEY (client, company_code)
    REFERENCES company_code (client, company_code) ON DELETE CASCADE,
  CONSTRAINT house_bank_bank_fk FOREIGN KEY (bank_country, bank_key)
    REFERENCES bank_master (bank_country, bank_key),
  CONSTRAINT house_bank_key_format CHECK (house_bank_key ~ '^[A-Z0-9]{1,5}$')
);

-- B. The accounts under them. ---------------------------------------------------
CREATE TABLE IF NOT EXISTS bank_account (
  client         varchar(4)  NOT NULL REFERENCES client (client) ON DELETE CASCADE,
  company_code   varchar(10) NOT NULL,
  house_bank_key varchar(5)  NOT NULL,
  account_id     varchar(5)  NOT NULL,
  account_number varchar(18) NOT NULL,
  iban           varchar(34),
  currency       char(3)     NOT NULL,
  gl_account     varchar(10) NOT NULL,
  created_by     varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at     timestamptz NOT NULL DEFAULT now(),
  changed_by     varchar(60),
  changed_at     timestamptz,
  CONSTRAINT bank_account_pk PRIMARY KEY (client, company_code, house_bank_key, account_id),
  CONSTRAINT bank_account_house_bank_fk FOREIGN KEY (client, company_code, house_bank_key)
    REFERENCES house_bank (client, company_code, house_bank_key) ON DELETE RESTRICT,
  CONSTRAINT bank_account_id_format CHECK (account_id ~ '^[A-Z0-9]{1,5}$'),
  CONSTRAINT bank_account_number_nonempty CHECK (length(btrim(account_number)) BETWEEN 1 AND 18),
  CONSTRAINT bank_account_iban_format CHECK (
    iban IS NULL OR iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'
  )
);

-- C. The two lookups this registry serves: a company code's house banks are
-- found by their primary key's prefix; the bank master's deletion guard
-- counts the house banks naming a bank, across every tenant.
CREATE INDEX IF NOT EXISTS house_bank_bank_idx ON house_bank (bank_country, bank_key);
