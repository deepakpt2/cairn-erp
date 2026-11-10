-- ---------------------------------------------------------------------------
-- SCR-036 stage 2 — the bank master house banks refer to
--
-- House banks (SCR-037) name a bank by country and key and display its name,
-- city and SWIFT code as facts they do not own. In the reference product
-- those facts live in a global bank master keyed by bank country and bank
-- key; this product's reference tables cover countries, currencies and
-- units only, so the master is created here, before FI12, by the owner's
-- ruling (R-86).
--
-- The table is global — no client column, no tenant isolation — because a
-- bank is a fact of the world, not of a tenant: the National Bank of Kuwait
-- is the same bank in every tenant, and keying it per tenant would let two
-- tenants disagree about what a bank key means. Its audit is actor columns
-- rather than change documents (also R-86): change history files per
-- tenant, and a global row has no tenant to file under.
--
-- The key is the bank country, held by foreign key to the country master's
-- key (a bank in a country that does not exist banks nowhere), and the bank
-- key within it, up to fifteen upper-case letters or digits — the national
-- bank identifier, at the width the owner's package gives it. The name is
-- required because an unnamed bank cannot be picked out of a list. City
-- and SWIFT are optional: not every branch needs either stated. The SWIFT
-- code, where present, must be a BIC — four letters of bank, two of
-- country, two of location, and optionally three of branch — eight or
-- eleven characters, never anything between.
--
-- No seeded rows: this product ships no standard master data (D-058), and
-- a bank master invented by the vendor would be worse than an empty one.
--
-- Nothing here can refuse: the table is new, and no existing row can
-- violate a rule it predates.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bank_master (
  bank_country char(2)     NOT NULL REFERENCES country (code),
  bank_key     varchar(15) NOT NULL,
  name         varchar(60) NOT NULL,
  city         varchar(35),
  swift        varchar(11),
  created_by   varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at   timestamptz NOT NULL DEFAULT now(),
  changed_by   varchar(60),
  changed_at   timestamptz,
  CONSTRAINT bank_master_pk PRIMARY KEY (bank_country, bank_key),
  CONSTRAINT bank_master_key_format CHECK (bank_key ~ '^[A-Z0-9]{1,15}$'),
  CONSTRAINT bank_master_name_nonempty CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  CONSTRAINT bank_master_city_nonempty CHECK (city IS NULL OR length(btrim(city)) BETWEEN 1 AND 35),
  CONSTRAINT bank_master_swift_format CHECK (
    swift IS NULL OR swift ~ '^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$'
  )
);

-- Finding a bank by the name an operator remembers.
CREATE INDEX IF NOT EXISTS bank_master_name_idx ON bank_master (name);
